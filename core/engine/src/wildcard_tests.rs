//! FILENAME: core/engine/src/wildcard_tests.rs
//! PURPOSE: Excel's three wildcard characters, and the five places they were
//!          missing or wrong — the exceljet glossary term "wildcard".
//!
//! WHAT ALREADY WORKED, so it is not re-litigated here: `xlookup_wildcard_match`
//! implements `*`, `?` and the `~` escape, case-insensitively and
//! budget-charged per recursive step, and it was correctly wired into the
//! COUNTIF/SUMIF/AVERAGEIF/MINIFS/MAXIFS family, the D-functions, MATCH
//! match_type 0 and XLOOKUP match_mode 2. Twelve of the fourteen functions
//! exceljet lists accepted wildcards.
//!
//! THE FIVE THAT DID NOT, and none of them produced an error:
//!
//!   =VLOOKUP("Jo*",...)      #N/A       plain equality, no wildcard at all
//!   =XMATCH("a~*b",rng,2)    wrong hit  a SECOND, older matcher; `~` compared literally
//!   =COUNTIF(rng,"=Jo*")     0          the `=` prefix was tested before the wildcard check
//!   =COUNTIF(rng,"<>J*")     wrong      same, via `<>`
//!   =COUNTIF(C:C,"1*")       counted 100, a NUMBER — wildcards are for text
//!   =SEARCH("?","abc")       3          the matcher wants the WHOLE remainder; SEARCH wants a position
//!
//! The VLOOKUP one had a second half worth recording: the CACHED path
//! (`vlookup_hlookup_cached`) had no wildcard bail-out either, so it served a
//! pattern from a string-equality index — meaning the same formula could answer
//! differently on a cold pass and a warm one. `wildcard_pattern` is now the one
//! place that decides "is this a pattern", so the scan and the cache cannot
//! disagree.

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn eval(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(grid).evaluate(&ast)
}
fn num(grid: &Grid, formula: &str) -> f64 {
    match eval(grid, formula) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` gave {:?}, expected a number", formula, other),
    }
}

/// A1:A4 = Joe, Jane, Bob, "a*b" (the last holds a LITERAL asterisk).
/// B1:B4 = 1..4. C1:C3 = the NUMBER 100, the TEXT "100x", the NUMBER 1.
fn fixture() -> Grid {
    let mut g = Grid::new();
    for (i, s) in ["Joe", "Jane", "Bob", "a*b"].iter().enumerate() {
        g.set_cell(i as u32, 0, Cell::new_text((*s).to_string()));
    }
    for (i, v) in [1.0, 2.0, 3.0, 4.0].iter().enumerate() {
        g.set_cell(i as u32, 1, Cell::new_number(*v));
    }
    g.set_cell(0, 2, Cell::new_number(100.0));
    g.set_cell(1, 2, Cell::new_text("100x".to_string()));
    g.set_cell(2, 2, Cell::new_number(1.0));
    g
}

#[test]
fn vlookup_and_hlookup_accept_wildcards() {
    let g = fixture();
    // Both used `values_equal`, a plain case-insensitive equality, so these were
    // #N/A while MATCH and XLOOKUP found the same row.
    assert_eq!(num(&g, "=VLOOKUP(\"Jo*\",A1:B4,2,FALSE)"), 1.0);
    assert_eq!(num(&g, "=VLOOKUP(\"J?e\",A1:B4,2,FALSE)"), 1.0);
    assert_eq!(num(&g, "=MATCH(\"Jo*\",A1:A4,0)"), 1.0, "the control that always worked");

    // HLOOKUP on the transposed shape.
    let mut h = Grid::new();
    for (i, s) in ["Joe", "Jane", "Bob"].iter().enumerate() {
        h.set_cell(0, i as u32, Cell::new_text((*s).to_string()));
    }
    for (i, v) in [1.0, 2.0, 3.0].iter().enumerate() {
        h.set_cell(1, i as u32, Cell::new_number(*v));
    }
    assert_eq!(num(&h, "=HLOOKUP(\"Ja*\",A1:C2,2,FALSE)"), 2.0);

    // A pattern that matches nothing is still #N/A, not the first row.
    assert_eq!(
        eval(&g, "=VLOOKUP(\"Z*\",A1:B4,2,FALSE)"),
        EvalResult::Error(CellError::NA)
    );
    // An ORDINARY lookup is unaffected — the fix must not turn every value into
    // a pattern.
    assert_eq!(num(&g, "=VLOOKUP(\"Bob\",A1:B4,2,FALSE)"), 3.0);
}

#[test]
fn one_wildcard_engine_serves_every_function() {
    let g = fixture();
    // XMATCH called a SECOND, older DP matcher that handled `*` and `?` but
    // compared `~` LITERALLY — so the escape worked everywhere in the product
    // except there, and `a~*b` meant "a, anything, b" instead of "a*b".
    assert_eq!(num(&g, "=XMATCH(\"a~*b\",A1:A4,2)"), 4.0);
    assert_eq!(num(&g, "=MATCH(\"a~*b\",A1:A4,0)"), 4.0, "the control");
    // ...and the escape still escapes in XMATCH's own idiom.
    assert_eq!(num(&g, "=XMATCH(\"a*b\",A1:A4,2)"), 4.0);
}

#[test]
fn an_operator_prefix_does_not_cancel_the_wildcard() {
    let g = fixture();
    // `parse_criteria` tested `<>` and `=` BEFORE the wildcard check, so both
    // compared a literal asterisk and matched nothing a user meant.
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"=Jo*\")"), 1.0);
    // Joe and Jane are like J*; Bob and "a*b" are not.
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"<>J*\")"), 2.0);
    // The plain forms are unchanged.
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"J*\")"), 2.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"Bob\")"), 1.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"<>Bob\")"), 3.0);
}

#[test]
fn wildcards_match_text_and_never_a_number() {
    let g = fixture();
    // C1 is the NUMBER 100 and C2 is the TEXT "100x". The matcher stringified
    // the cell first, so `"1*"` counted both — Excel counts only the text.
    assert_eq!(num(&g, "=COUNTIF(C1:C3,\"1*\")"), 1.0);
    // A number still matches a NUMERIC criteria, which is the control that the
    // change did not simply stop numbers matching anything.
    assert_eq!(num(&g, "=COUNTIF(C1:C3,100)"), 1.0);
    assert_eq!(num(&g, "=COUNTIF(C1:C3,\">50\")"), 1.0);
}

#[test]
fn the_tilde_escape_is_honoured_by_the_criteria_family() {
    let g = fixture();
    // `"~*"` is the literal string `*`, so it matches a cell whose WHOLE value
    // is an asterisk — none here. Before `has_wildcard` existed, the naive
    // `contains('*')` test sent this down the wildcard path, where the leading
    // `~` was consumed as an escape and the pattern became "match anything".
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"~*\")"), 0.0);
    // ...and it does match when a cell really holds one.
    let mut star = Grid::new();
    star.set_cell(0, 0, Cell::new_text("*".to_string()));
    star.set_cell(1, 0, Cell::new_text("anything".to_string()));
    assert_eq!(num(&star, "=COUNTIF(A1:A2,\"~*\")"), 1.0);
    assert_eq!(num(&star, "=COUNTIF(A1:A2,\"*\")"), 2.0, "unescaped matches both");
}

#[test]
fn search_reports_a_position_rather_than_requiring_a_whole_match() {
    let g = fixture();
    // The shared matcher requires the pattern to consume the ENTIRE text — right
    // for COUNTIF and MATCH, wrong for SEARCH, which is looking for a POSITION.
    // The loop fed it `within_text[pos..]`, so the only position that could
    // succeed was the one where the pattern happened to be the whole remainder.
    assert_eq!(num(&g, "=SEARCH(\"?\",\"abc\")"), 1.0);
    assert_eq!(num(&g, "=SEARCH(\"a*c\",\"xabcy\")"), 2.0);
    assert_eq!(num(&g, "=SEARCH(\"b?\",\"abcd\")"), 2.0);
    // An escaped asterisk finds the literal one.
    assert_eq!(num(&g, "=SEARCH(\"~*\",\"a*b\")"), 2.0);
    // The NON-wildcard path is untouched.
    assert_eq!(num(&g, "=SEARCH(\"b\",\"abc\")"), 2.0);
    assert_eq!(num(&g, "=SEARCH(\"c\",\"abc\",2)"), 3.0);
    assert_eq!(
        eval(&g, "=SEARCH(\"z*\",\"abc\")"),
        EvalResult::Error(CellError::Value),
        "a pattern that is not there is still #VALUE!"
    );
    // FIND is case-sensitive and takes NO wildcards, which is the whole
    // difference between it and SEARCH. It must not have gained any.
    assert_eq!(
        eval(&g, "=FIND(\"?\",\"abc\")"),
        EvalResult::Error(CellError::Value)
    );
}

// ===================================================================
// CHAR / UNICHAR (glossary term "ascii")
// ===================================================================

#[test]
fn char_reads_its_argument_as_windows_1252_like_excel() {
    let g = Grid::new();
    // The 0-127 range this term is actually about was always exact, and stays.
    assert_eq!(eval(&g, "=CHAR(65)"), EvalResult::Text("A".into()));
    assert_eq!(eval(&g, "=CHAR(10)"), EvalResult::Text("\n".into()));
    assert_eq!(eval(&g, "=CHAR(9)"), EvalResult::Text("\t".into()));

    // 128-159 is where Latin-1 and Windows-1252 disagree, and `n as u8 as char`
    // gave the Latin-1 answer: an invisible C1 control character where Excel has
    // typographic punctuation.
    assert_eq!(eval(&g, "=CHAR(128)"), EvalResult::Text("\u{20AC}".into()), "euro sign");
    assert_eq!(eval(&g, "=CHAR(133)"), EvalResult::Text("\u{2026}".into()), "ellipsis");
    assert_eq!(eval(&g, "=CHAR(147)"), EvalResult::Text("\u{201C}".into()), "left double quote");
    assert_eq!(eval(&g, "=CHAR(150)"), EvalResult::Text("\u{2013}".into()), "en dash");
    assert_eq!(eval(&g, "=CHAR(153)"), EvalResult::Text("\u{2122}".into()), "trade mark");

    // 160-255 agree, and must not have moved.
    assert_eq!(eval(&g, "=CHAR(169)"), EvalResult::Text("\u{00A9}".into()), "copyright");
    assert_eq!(eval(&g, "=CHAR(255)"), EvalResult::Text("\u{00FF}".into()));

    // The domain is unchanged.
    assert_eq!(eval(&g, "=CHAR(0)"), EvalResult::Error(CellError::Value));
    assert_eq!(eval(&g, "=CHAR(256)"), EvalResult::Error(CellError::Value));
}

#[test]
fn unichar_refuses_zero_instead_of_returning_a_nul() {
    let g = Grid::new();
    // `n as u32` SATURATED, so both of these produced code point 0 — a NUL
    // character sitting in a cell, invisible, and saved to the file.
    assert_eq!(eval(&g, "=UNICHAR(0)"), EvalResult::Error(CellError::Value));
    assert_eq!(eval(&g, "=UNICHAR(-1)"), EvalResult::Error(CellError::Value));
    assert_eq!(eval(&g, "=UNICHAR(1114112)"), EvalResult::Error(CellError::Value));
    // A surrogate half is in range and is not a character.
    assert_eq!(eval(&g, "=UNICHAR(55296)"), EvalResult::Error(CellError::Value));
    // The ordinary cases are untouched.
    assert_eq!(eval(&g, "=UNICHAR(65)"), EvalResult::Text("A".into()));
    assert_eq!(eval(&g, "=UNICHAR(8364)"), EvalResult::Text("\u{20AC}".into()));
    assert_eq!(eval(&g, "=UNICODE(\"A\")"), EvalResult::Number(65.0));
}

#[test]
fn a_backtracking_bomb_still_terminates() {
    // The matcher backtracks, so a pattern like this is exponential in the
    // number of stars. It is charged per recursive step and answers #LIMIT!
    // rather than hanging — a property the new SEARCH path must not have lost,
    // since it appends a star of its own to every pattern.
    let g = fixture();
    let bomb = "=SEARCH(\"*a*a*a*a*a*a*a*a*a*b\",\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\")";
    assert!(
        matches!(
            eval(&g, bomb),
            EvalResult::Error(CellError::Limit) | EvalResult::Error(CellError::Value)
        ),
        "the bomb must be bounded, not hang"
    );
}
