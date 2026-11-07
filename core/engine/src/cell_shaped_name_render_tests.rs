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
        // A free name is quoted as either half of a range (BUG-0739: the
        // parser reads `X1:'D1'` back now, as Excel shows `SUM(J881:'D5')`
        // [LIVE, lane formd p2.json]; this row pinned it bare while it could
        // not). A binder in scope stays bare.
        ("=LET(X1,1,SUM(X1:D1))", "LET(X1,1,SUM(X1:'D1'))"),
        ("=LET(X1,1,SUM(D1:X1))", "LET(X1,1,SUM('D1':X1))"),
        // Behind a sheet the halves of a range of names stay bare.
        ("=LET(A1,5,SUM(Sheet2!D1:D2)+A1)", "LET(A1,5,SUM(SHEET2!D1:D2)+A1)"),
        // One name behind a sheet or a 3-D span is quoted, as Excel shows it
        // [LIVE, lane formula p1.json: `=LET(A1,2,Sheet2!'A1')`,
        // `=LET(A1,2,SUM(Sheet1:Sheet2!'A1'))`].
        ("=LET(A1,2,Sheet2!A1)", "LET(A1,2,SHEET2!'A1')"),
        ("=LET(A1,2,SUM(Sheet1:Sheet2!A1))", "LET(A1,2,SUM(SHEET1:SHEET2!'A1'))"),
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
        // Behind a sheet and a 3-D span the display quotes a name (the parser
        // reads `Sheet2!'D1'` back, BUG-0739); the STORED text of a formula
        // declaring a cell-shaped name stays bare.
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

/// A formula read in R1C1 only for an R1C1 spelling (`=R[-1]C+D5`, no
/// cell-shaped binder) holds the NAME `D5`, and the collapsed text the .xlsx
/// writer reads keeps it quoted, as the persisted text does: bare, the writer
/// wrote `J59+D5`, the CELL D5, where [LIVE, Excel 16, verify-formula p1.json]
/// Excel writes `J297+_xlnm.D5` (wave-1 verify finding, lane xlsx).
///
/// SABOTAGE (xlsx-collapse): `collapse_formula_text` renders with
/// `quote_cell_names` false again; the quote is lost here.
#[test]
fn the_collapse_keeps_a_cell_shaped_name_quoted_where_the_stored_text_does() {
    for (stored, collapsed) in [
        ("J59+'D5'", "J59+'D5'"),
        ("SUM(J59:'D5')", "SUM(J59:'D5')"),
        ("__INVOKE__(\"Dbl\",LAMBDA(x,x*2),'D5')", "Dbl('D5')"),
    ] {
        assert_eq!(collapse_formula_text(stored), collapsed, "for {stored}");
        let tree = parser::parse(&format!("={stored}")).expect("parses");
        assert_eq!(collapse_formula_text(&render_formula_raw(&tree)), collapsed, "re-rendered {stored}");
    }
    // A formula declaring a cell-shaped name stays bare (read in R1C1).
    assert_eq!(collapse_formula_text("LET(A1,5,A1)+D1"), "LET(A1,5,A1)+D1");
}
