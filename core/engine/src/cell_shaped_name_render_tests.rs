//! FILENAME: core/engine/src/cell_shaped_name_render_tests.rs
//! PURPOSE: The formula bar shows a name spelled like a cell that no LET /
//!          LAMBDA in scope binds QUOTED, as Excel does, and the quoted text
//!          reads back as the same formula.
//! CONTEXT: A `#[path]` child of `ast_render`.
//!
//! [LIVE, Excel 16, 2026-11-05, rev-parse probe B, `Range.Formula2` read back
//! after typing] `=D1+LET(A1,5,A1)` shows `='D1'+LET(A1,5,A1)`,
//! `=SUM(D1:D2,LAMBDA(a1,a1)(1))` `=SUM('D1':'D2',LAMBDA(a1,a1)(1))`,
//! `=LET(x1,1,x1)+SUM(D1:D2)` `=LET(x1,1,x1)+SUM('D1':'D2')`,
//! `=LET(A1,5,A1+INDEX(T1,1,1))` `=LET(A1,5,A1+INDEX('T1',1,1))`,
//! `=LET(n,5,LAMBDA(n1,n1+n)(1))+D1` `...+'D1'` and `=IF(TRUE,D1,LET(A1,1,A1))`
//! `=IF(TRUE,'D1',LET(A1,1,A1))`; a binder and its uses in scope stay bare.

use super::*;

fn shown(typed: &str) -> String {
    render_formula(&parser::parse(typed).unwrap_or_else(|e| panic!("`{typed}` parses: {e:?}")))
}

#[test]
fn the_formula_bar_quotes_a_name_spelled_like_a_cell_as_excel_does() {
    let mut wrong = Vec::new();
    for (typed, excel) in [
        ("=D1+LET(A1,5,A1)", "'D1'+LET(A1,5,A1)"),
        ("=LET(x1,1,x1)+SUM(D1:D2)", "LET(X1,1,X1)+SUM('D1':'D2')"),
        ("=LET(A1,5,A1+INDEX(T1,1,1))", "LET(A1,5,A1+INDEX('T1',1,1))"),
        ("=IF(TRUE,D1,LET(A1,1,A1))", "IF(TRUE,'D1',LET(A1,1,A1))"),
        // A LET name is not bound in its own value.
        ("=LET(E5,E5+1,E5)", "LET(E5,'E5'+1,E5)"),
        // A real reference, and a formula declaring no cell-shaped name, as before.
        ("=LET(A1,5,A1+$D1)", "LET(A1,5,A1+$D1)"),
        // The binder keeps its typed case ([LIVE] legacystats p2.json J21:
        // `=LET(x,5,x+D1)`; this row pinned Calcula's old upper-casing).
        ("=LET(x,5,x+D1)", "LET(x,5,x+D1)"),
        // Where a quote would not read back as a range half, the halves stay bare
        // (the R1C1 fallback reads them as the names they are).
        ("=LET(X1,1,SUM(X1:D1))", "LET(X1,1,SUM(X1:D1))"),
        ("=LET(X1,1,SUM(D1:X1))", "LET(X1,1,SUM('D1':X1))"),
        ("=LET(A1,5,SUM(Sheet2!D1:D2)+A1)", "LET(A1,5,SUM(SHEET2!D1:D2)+A1)"),
    ] {
        let got = shown(typed);
        if got != excel {
            wrong.push(format!("{typed}: shown {got}, Excel shows ={excel}"));
        }
    }
    assert!(wrong.is_empty(), "the formula bar disagrees with Excel:\n  {}", wrong.join("\n  "));

    // The LAMBDA cases: the parameter bare in its body, the free name quoted.
    let lambda = shown("=SUM(D1:D2,LAMBDA(a1,a1)(1))");
    assert!(lambda.starts_with("SUM('D1':'D2',"), "{lambda}");
    assert!(lambda.contains("LAMBDA(A1,A1)"), "a LAMBDA parameter is never quoted: {lambda}");
    let nested = shown("=LET(n,5,LAMBDA(n1,n1+n)(1))+D1");
    assert!(nested.ends_with("+'D1'"), "{nested}");
    // `n` keeps its declared spelling (lane formd, NEW-let-param-case); the
    // cell-shaped `n1` is the R1C1 fallback's name and is shown as before.
    assert!(nested.starts_with("LET(n,5,"), "{nested}");
    assert!(nested.contains("LAMBDA(N1,N1+n)"), "{nested}");
}

/// The quoted text reads back as the SAME formula, and the raw text
/// persistence writes (and the collapse the .xlsx writer reads) stays bare.
#[test]
fn the_quoted_spelling_reads_back_and_never_reaches_the_file() {
    for typed in [
        "=D1+LET(A1,5,A1)",
        "=LET(x1,1,x1)+SUM(D1:D2)",
        "=LET(A1,5,A1+INDEX(T1,1,1))",
        "=SUM(D1:D2,LAMBDA(a1,a1)(1))",
        "=LET(E5,E5+1,E5)",
        "=LET(X1,1,SUM(D1:X1))",
        "=LET(A1,SEQUENCE(3),SUM(D1#)+A1)",
        // Behind a sheet and a 3-D span a name stays bare: a quote after `!`
        // would not parse back.
        "=LET(A1,2,Sheet2!D1:D2)",
        "=LET(A1,2,Sheet2!D1+A1)",
        "=LET(A1,2,SUM(Sheet1:Sheet2!D1))",
        "=LET(A1,2,SUM(Sheet1:Sheet2!D1:D2))",
    ] {
        let tree = parser::parse(typed).expect("parses");
        let display = render_formula(&tree);
        let back = parser::parse(&format!("={}", display)).unwrap_or_else(|e| panic!("`={display}` does not parse back: {e:?}"));
        assert_eq!(render_formula_raw(&back), render_formula_raw(&tree), "`={display}` read back as another formula");
        let raw = render_formula_raw(&tree);
        assert!(!raw.contains('\''), "the persisted text must stay bare: {raw}");
        assert!(!collapse_formula_text(&raw).contains('\''), "the .xlsx writer's text must stay bare");
    }
}
