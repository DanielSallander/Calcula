//! FILENAME: core/engine/src/text_delimiter_tests.rs
//! PURPOSE: TEXTBEFORE / TEXTAFTER / TEXTSPLIT read a delimiter ARRAY as a
//! set of alternatives and honour match_mode, match_end, if_not_found,
//! ignore_empty and pad_with as Excel does (lane formd, NEW-textbefore-delims).
//!
//! [LIVE] Excel 16, 2026-11-05 (SCRATCH/formd/p1.json, p2.json): a fresh
//! Excel 16 instance's new workbook with A1:A3 = 1,2,3, B1 = 10, C1 = "-",
//! C2 = "+", C3 and A6 blank; each formula typed (`Formula2`) into column J
//! and its value (or its spill, cell by cell) read back as text. Every row
//! below is that probe's answer, generated from the JSON. Calcula lifted over
//! a delimiter array (`=TEXTBEFORE("a-b+c",{"-","+"})` spilled a|a-b),
//! ignored match_mode / match_end, and TEXTSPLIT split on one string and
//! ignored ignore_empty / match_mode / pad_with.

use crate::cell::Cell;
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheet() -> Grid {
    let mut grid = Grid::new();
    for row in 0..3u32 {
        grid.set_cell(row, 0, Cell::new_number(f64::from(row + 1)));
    }
    grid.set_cell(0, 1, Cell::new_number(10.0));
    grid.set_cell(1, 1, Cell::new_number(20.0));
    grid.set_cell(2, 1, Cell::new_number(30.0));
    grid.set_cell(0, 2, Cell::new_text("-".to_string()));
    grid.set_cell(1, 2, Cell::new_text("+".to_string()));
    grid
}

fn typed(formula: &str) -> EvalResult {
    let cell = crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"));
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let grid = sheet();
    Evaluator::new(&grid).evaluate(ast)
}

fn scalar(v: &EvalResult) -> String {
    match v {
        EvalResult::Number(n) => format!("{n}"),
        EvalResult::Text(s) => s.clone(),
        EvalResult::Boolean(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        EvalResult::Error(e) => e.as_literal().to_string(),
        EvalResult::Blank => String::new(),
        other => format!("{other:?}"),
    }
}

/// The result as the probe read Excel's: rows joined by `;`, cells by `,`.
fn shown(v: &EvalResult) -> String {
    match v {
        EvalResult::Array(rows) => {
            if rows.iter().any(|r| matches!(r, EvalResult::Array(_))) {
                rows.iter()
                    .map(|r| match r {
                        EvalResult::Array(cells) => cells.iter().map(scalar).collect::<Vec<_>>().join(","),
                        other => scalar(other),
                    })
                    .collect::<Vec<_>>()
                    .join(";")
            } else {
                rows.iter().map(scalar).collect::<Vec<_>>().join(";")
            }
        }
        other => scalar(other),
    }
}

/// [LIVE] Excel 16's answer for each formula (generated from the probe).
const EXCEL: &[(&str, &str)] = &[
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"})", "a"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"},2)", "a-b"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"},-1)", "a-b"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"},-2)", "a"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"},3)", "#N/A"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\";\"+\"})", "a"),
    ("=TEXTBEFORE(\"a-b+c\",C1:C2)", "a"),
    ("=TEXTBEFORE(\"a-b+c\",C1:C3)", ""),
    ("=TEXTBEFORE(\"a-b+c\",{\"+\",\"-\"})", "a"),
    ("=TEXTBEFORE(\"abcabc\",{\"ab\",\"b\"},2)", "abc"),
    ("=TEXTBEFORE(\"abcabc\",{\"b\",\"ab\"},2)", "abc"),
    ("=TEXTBEFORE(\"abcabc\",{\"b\",\"ab\"},1)", ""),
    ("=TEXTBEFORE(\"abcabc\",{\"bc\",\"b\"},-1)", "abca"),
    ("=TEXTBEFORE(\"aaaa\",\"aa\",2)", "aa"),
    ("=TEXTBEFORE(\"aaa\",\"aa\",-1)", "a"),
    ("=TEXTAFTER(\"aaa\",\"aa\",-1)", ""),
    ("=TEXTAFTER(\"aaa\",\"aa\",1)", "a"),
    ("=TEXTBEFORE(\"aaaaa\",\"aa\",-2)", "a"),
    ("=TEXTBEFORE(\"a--b\",{\"-\",\"--\"})", "a"),
    ("=TEXTBEFORE(\"a--b\",{\"--\",\"-\"},2)", "#N/A"),
    ("=TEXTAFTER(\"a--b\",{\"-\",\"--\"})", "b"),
    ("=TEXTAFTER(\"a--b\",{\"--\",\"-\"})", "b"),
    ("=TEXTAFTER(\"a--b\",{\"-\",\"--\"},2)", "#N/A"),
    ("=TEXTAFTER(\"a--b\",{\"-\",\"--\"},-1)", "b"),
    ("=TEXTAFTER(\"a-b+c\",{\"-\",\"+\"},-1)", "c"),
    ("=TEXTAFTER(\"a-b+c\",{\"-\",\"+\"},2)", "c"),
    ("=TEXTBEFORE(\"aXbxc\",\"x\")", "aXb"),
    ("=TEXTBEFORE(\"aXbxc\",\"x\",1,1)", "a"),
    ("=TEXTBEFORE(\"aXbxc\",\"x\",1,0)", "aXb"),
    ("=TEXTBEFORE(\"aXbxc\",{\"X\",\"x\"},2,0)", "aXb"),
    ("=TEXTBEFORE(\"aXbxc\",\"X\",-1,1)", "aXb"),
    ("=TEXTBEFORE(\"abc\",\"-\",1,0,1)", "abc"),
    ("=TEXTBEFORE(\"abc\",\"-\",1,0,0)", "#N/A"),
    ("=TEXTBEFORE(\"a-b\",\"-\",2,0,1)", "a-b"),
    ("=TEXTBEFORE(\"a-b\",\"-\",3,0,1)", "#N/A"),
    ("=TEXTBEFORE(\"a-b\",\"-\",-2,0,1)", ""),
    ("=TEXTBEFORE(\"a-b\",\"-\",-3,0,1)", "#N/A"),
    ("=TEXTBEFORE(\"abc\",\"-\",-1,0,1)", ""),
    ("=TEXTBEFORE(\"a-b\",\"-\",-1,0,1)", "a"),
    ("=TEXTAFTER(\"abc\",\"-\",1,0,1)", ""),
    ("=TEXTAFTER(\"a-b\",\"-\",2,0,1)", ""),
    ("=TEXTAFTER(\"a-b\",\"-\",-2,0,1)", "a-b"),
    ("=TEXTAFTER(\"abc\",\"-\",-1,0,1)", "abc"),
    ("=TEXTAFTER(\"a-b\",\"-\",3,0,1)", "#N/A"),
    ("=TEXTAFTER(\"a-b\",\"-\",-3,0,1)", "#N/A"),
    ("=TEXTBEFORE(\"abc\",\"x\",1,0,0,\"nf\")", "nf"),
    ("=TEXTBEFORE(\"abc\",\"x\",,,,\"nf\")", "nf"),
    ("=TEXTBEFORE(\"abc\",\"x\",1,0,0,)", "#N/A"),
    ("=TEXTBEFORE(\"abc\",\"\")", ""),
    ("=TEXTBEFORE(\"abc\",\"\",-1)", "abc"),
    ("=TEXTBEFORE(\"abc\",\"\",2)", ""),
    ("=TEXTBEFORE(\"abc\",\"\",-2)", "abc"),
    ("=TEXTAFTER(\"abc\",\"\")", "abc"),
    ("=TEXTAFTER(\"abc\",\"\",-1)", ""),
    ("=TEXTAFTER(\"abc\",\"\",2)", "abc"),
    ("=TEXTAFTER(\"abc\",\"\",-2)", ""),
    ("=TEXTBEFORE(\"abc\",{\"\",\"b\"})", ""),
    ("=TEXTAFTER(\"abc\",{\"\",\"b\"})", "abc"),
    ("=TEXTBEFORE(\"abc\",{\"b\",\"\"})", ""),
    ("=TEXTBEFORE(\"abc\",{\"b\",\"\"},-1)", "abc"),
    ("=TEXTBEFORE(\"abc\",\"\",,,1)", ""),
    ("=TEXTBEFORE(\"abc\",\"b\",4)", "#VALUE!"),
    ("=TEXTBEFORE(\"abc\",\"b\",-4)", "#VALUE!"),
    ("=TEXTBEFORE(\"abc\",\"b\",3)", "#N/A"),
    ("=TEXTBEFORE(\"abc\",\"b\",0)", "#VALUE!"),
    ("=TEXTBEFORE(\"abc\",\"b\",1.9)", "a"),
    ("=TEXTBEFORE(\"abc\",\"b\",-1.9)", "#N/A"),
    ("=TEXTBEFORE(\"abc\",\"b\",\"1\")", "a"),
    ("=TEXTBEFORE(\"abc\",\"b\",1,2)", "#VALUE!"),
    ("=TEXTBEFORE(\"abc\",\"b\",1,-1)", "#VALUE!"),
    ("=TEXTBEFORE(\"aBc\",\"b\",1,TRUE)", "a"),
    ("=TEXTBEFORE(\"abc\",\"b\",1,0,2)", "#VALUE!"),
    ("=TEXTBEFORE(\"abc\",\"x\",1,0,-1)", "#VALUE!"),
    ("=TEXTBEFORE(\"abc\",\"b\",1,\"x\")", "#VALUE!"),
    ("=TEXTBEFORE(\"abc\",\"b\",1,0.5)", "a"),
    ("=TEXTBEFORE({\"a-b\",\"c-d\"},\"-\")", "a,c"),
    ("=TEXTBEFORE(\"a-b-c\",\"-\",{1,2})", "a,a-b"),
    ("=TEXTBEFORE(\"aXbxc\",\"x\",1,{0,1})", "aXb,a"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"},{1,2})", "a,a-b"),
    ("=TEXTBEFORE({\"a-b\";\"c+d\"},{\"-\",\"+\"})", "a;c"),
    ("=TEXTBEFORE(\"abc\",\"x\",1,0,0,{\"p\",\"q\"})", "p,q"),
    ("=TEXTBEFORE(\"a-b\",\"-\",1,0,{0,1})", "a,a"),
    ("=TEXTBEFORE(123456,4)", "123"),
    ("=TEXTBEFORE(TRUE,\"U\")", "TR"),
    ("=TEXTBEFORE(\"a-b\",1/0)", "#DIV/0!"),
    ("=TEXTBEFORE(1/0,\"-\")", "#DIV/0!"),
    ("=TEXTBEFORE(\"a-b\",\"-\",1/0)", "#DIV/0!"),
    ("=TEXTBEFORE(\"a-b\",\"x\",1,0,0,1/0)", "#DIV/0!"),
    ("=TEXTBEFORE(\"a-b\",\"-\",1,0,0,1/0)", "a"),
    ("=TEXTBEFORE(\"ÄBC\",\"ä\",1,1)", ""),
    ("=TEXTBEFORE(\"straße\",\"SS\",1,1)", "#N/A"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\";\"x\",\"y\"},2)", "a-b"),
    ("=TEXTBEFORE(\"a1b2c\",{1,2},2)", "a1b"),
    ("=TEXTBEFORE(A1:A3,\"x\",1,0,1)", "1;2;3"),
    ("=TEXTSPLIT(\"a-b+c\",{\"-\",\"+\"})", "a,b,c"),
    ("=TEXTSPLIT(\"a,b;c,d\",\",\",\";\")", "a,b;c,d"),
    ("=TEXTSPLIT(\"a,b;c\",\",\",\";\")", "a,b;c,#N/A"),
    ("=TEXTSPLIT(\"a,b;c\",\",\",\";\",,,\"-\")", "a,b;c,-"),
    ("=TEXTSPLIT(\"a,,b\",\",\",,TRUE)", "a,b"),
    ("=TEXTSPLIT(\"a,,b\",\",\",,FALSE)", "a,,b"),
    ("=TEXTSPLIT(\"aXbxc\",\"x\",,,1)", "a,b,c"),
    ("=TEXTSPLIT(\"aXbxc\",\"x\")", "aXb,c"),
    ("=TEXTSPLIT(\"a;b\",,\";\")", "a;b"),
    ("=TEXTSPLIT(\"a-b;c+d\",{\"-\",\"+\"},\";\")", "a,b;c,d"),
    ("=TEXTSPLIT(\"a1b2c\",,{\"1\",\"2\"})", "a;b;c"),
    ("=TEXTSPLIT(\"abc\",\"\")", "#VALUE!"),
    ("=TEXTSPLIT(\"abc\",{\"\",\"b\"})", "#VALUE!"),
    ("=TEXTSPLIT(\"abc\",,\"\")", "#VALUE!"),
    ("=TEXTSPLIT({\"a-b\",\"c-d\"},\"-\")", "a,c"),
    ("=TEXTSPLIT({\"a-b\";\"c-d\"},\"-\")", "a;c"),
    ("=TEXTSPLIT(\"a--b\",{\"-\",\"--\"})", "a,b"),
    ("=TEXTSPLIT(\"a--b\",{\"--\",\"-\"})", "a,b"),
    ("=TEXTSPLIT(\"a,b;;c\",\",\",\";\",TRUE)", "a,b;c,#N/A"),
    ("=TEXTSPLIT(\"a,b;;c\",\",\",\";\")", "a,b;,#N/A;c,#N/A"),
    ("=TEXTSPLIT(\",a,\",\",\")", ",a,"),
    ("=TEXTSPLIT(\",a,\",\",\",,TRUE)", "a"),
    ("=TEXTSPLIT(\"a\",\",\")", "a"),
    ("=TEXTSPLIT(\"\",\",\")", "#VALUE!"),
    ("=TEXTSPLIT(\"a,b\",\",\",\",\")", "a,b"),
    ("=TEXTSPLIT(\"a,b\",1/0)", "#DIV/0!"),
    ("=TEXTSPLIT(1/0,\",\")", "#DIV/0!"),
    ("=TEXTSPLIT(\"a,b\",\",\",,,2)", "#VALUE!"),
    ("=TEXTSPLIT(\"a,b\",\",\",,,-1)", "#VALUE!"),
    ("=TEXTSPLIT(\"a,b;c\",\",\",\";\",,,)", "a,b;c,0"),
    ("=TEXTSPLIT(\"a,b;c\",\",\",\";\",,,1/0)", "a,b;c,#DIV/0!"),
    ("=TEXTSPLIT(\"a,b\",)", "#VALUE!"),
    ("=TEXTSPLIT(\"a,b\",,)", "#VALUE!"),
    ("=TEXTSPLIT(123,2)", "1,3"),
    ("=TEXTSPLIT(\"a,b\",\",\",,\"x\")", "#VALUE!"),
    ("=TEXTSPLIT(\"a,b\",\",\",,2)", "a,b"),
    ("=TEXTSPLIT(\"a-b;c\",{\"-\",\";\"},\";\")", "a,b,c"),
    ("=TEXTSPLIT(\"a,b;c,d,e\",\",\",\";\",,,\"\")", "a,b,;c,d,e"),
    ("=TEXTSPLIT(\"a,b\",\",\",,,,\"p\")", "a,b"),
    ("=TEXTSPLIT(\"a,b\",\",\",1/0)", "#DIV/0!"),
    ("=TEXTSPLIT(\"a,b\",\",\",,,\"x\")", "#VALUE!"),
    ("=TEXTSPLIT(\"aXbxc\",\"x\",,,TRUE)", "a,b,c"),
    ("=TEXTSPLIT(\"a;b;\",,\";\",TRUE)", "a;b"),
    ("=TEXTSPLIT(\"a;b;\",,\";\")", "a;b;"),
    ("=TEXTAFTER(\"a--b\",{\"-\",\"--\"},-2)", "b"),
    ("=TEXTBEFORE(\"a--b\",{\"-\",\"--\"},-1)", "a-"),
    ("=TEXTBEFORE(\"a---b\",{\"-\",\"--\"},-1)", "a--"),
    ("=TEXTBEFORE(\"a---b\",{\"-\",\"--\"},-2)", "a-"),
    ("=TEXTBEFORE(\"a---b\",{\"-\",\"--\"},2)", "a--"),
    ("=TEXTAFTER(\"a---b\",{\"--\",\"-\"},-2)", "b"),
    ("=TEXTAFTER(\"a---b\",{\"--\",\"-\"},-1)", "b"),
    ("=TEXTAFTER(\"abc\",{\"\",\"a\"})", "abc"),
    ("=TEXTAFTER(\"abc\",{\"a\",\"\"})", "abc"),
    ("=TEXTBEFORE(\"abc\",{\"\",\"c\"},-1)", "abc"),
    ("=TEXTBEFORE(\"abc\",{\"c\",\"\"},-1)", "abc"),
    ("=TEXTBEFORE(\"abc\",\"\",3)", ""),
    ("=TEXTBEFORE(\"abc\",\"\",4)", ""),
    ("=TEXTBEFORE(\"abc\",\"\",-3)", "abc"),
    ("=TEXTBEFORE(\"abc\",\"\",-4)", "abc"),
    ("=TEXTBEFORE(\"abc\",\"\",1,0,1)", ""),
    ("=TEXTBEFORE(\"abc\",\"\",-1,0,1)", "abc"),
    ("=TEXTBEFORE(\"a-b-c\",\"-\",-3,0,1)", ""),
    ("=TEXTBEFORE(\"a-b-c\",\"-\",3,0,1)", "a-b-c"),
    ("=TEXTBEFORE(\"a-b-c\",\"-\",4,0,1)", "#N/A"),
    ("=TEXTAFTER(\"a-b-c\",\"-\",-3,0,1)", "a-b-c"),
    ("=TEXTAFTER(\"a-b-c\",\"-\",3,0,1)", ""),
    ("=TEXTBEFORE(\"\",\"-\")", "#N/A"),
    ("=TEXTBEFORE(\"\",\"-\",1,0,1)", "#VALUE!"),
    ("=TEXTBEFORE(\"\",\"\")", ""),
    ("=TEXTBEFORE(\"\",\"\",-1)", ""),
    ("=TEXTAFTER(\"\",\"\")", ""),
    ("=TEXTAFTER(\"\",\"-\",1,0,1)", "#VALUE!"),
    ("=TEXTBEFORE(\"a\",{\"-\"},1,0,1,\"x\")", "a"),
    ("=TEXTBEFORE(\"a-b\",IF({1,0},\"-\",1/0))", "#DIV/0!"),
    ("=TEXTBEFORE(\"a-b\",IF({1,0},\"+\",1/0))", "#DIV/0!"),
    ("=TEXTBEFORE(\"a-b\",IF({1,0},\"-\",\"\"))", ""),
    ("=TEXTBEFORE(\"a10b\",B1)", "a"),
    ("=TEXTBEFORE(\"aTRUEb\",TRUE)", "a"),
    ("=TEXTBEFORE(\"a-b\",A6)", ""),
    ("=TEXTBEFORE(\"ABC\",\"b\",1,1)", "A"),
    ("=TEXTBEFORE(\"xÉy\",\"é\",1,1)", "x"),
    ("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"},1,0,0,\"nf\")", "a"),
    ("=TEXTBEFORE(\"a-b+c\",\"-\",1,0,0,1/0)", "a"),
    ("=TEXTBEFORE(\"abcab\",\"ab\",-1)", "abc"),
    ("=TEXTBEFORE(\"ab-ab\",\"ab\",-2)", ""),
    ("=TEXTBEFORE(\"a-b\",\"-\",,,,)", "a"),
    ("=TEXTBEFORE(\"a-b\",\"-\",,)", "a"),
    ("=TEXTBEFORE(\"a-b\",\"-\",)", "a"),
    ("=TEXTAFTER(\"a-b\",\"-\",)", "b"),
    ("=TEXTBEFORE(\"a-b\",,1)", ""),
    ("=TEXTAFTER(\"a-b\",)", "a-b"),
    ("=TEXTBEFORE(\"abc\",\"\",-1,0,0,\"nf\")", "abc"),
    ("=TEXTBEFORE(\"a-b\",\"-\",1,\"1\")", "a"),
    ("=TEXTBEFORE(\"a-b\",\"-\",1,\"TRUE\")", "#VALUE!"),
    ("=TEXTBEFORE(\"a-b\",\"-\",1,0,\"1\")", "a"),
    ("=TEXTBEFORE(\"a-b\",\"-\",\"x\")", "#VALUE!"),
    ("=TEXTBEFORE(\"a-b\",\"-\",TRUE)", "a"),
    ("=TEXTSPLIT(\"a-b\",{\"-\",\"\"})", "#VALUE!"),
    ("=TEXTSPLIT(\"a,b;c,d\",{\",\",\";\"},\";\")", "a,b,c,d"),
    ("=TEXTSPLIT(\"a;b\",\";\",\";\")", "a,b"),
    ("=TEXTSPLIT(\"a,b\",\",\",,,1/0)", "#DIV/0!"),
    ("=TEXTSPLIT(\"a,b\",\",\",,1/0)", "#DIV/0!"),
    ("=TEXTSPLIT(\"a,,b;c\",\",\",\";\",TRUE,,\"p\")", "a,b;c,p"),
    ("=TEXTSPLIT(\"a,b\",IF({1,0},\",\",1/0))", "#DIV/0!"),
    ("=TEXTSPLIT(\"a--b-c\",\"-\",,TRUE)", "a,b,c"),
    ("=TEXTSPLIT(A1:A3,\",\")", "1;2;3"),
    ("=TEXTSPLIT({\"a,b\";\"c,d\"},\",\",\";\")", "a;c"),
    ("=TEXTSPLIT({\"a,b\";\"c,d\"},\",\")", "a;c"),
    ("=TEXTSPLIT(\"aXb\",\"x\",,,1,\"\")", "a,b"),
    ("=TEXTSPLIT(\"a,b;c\",\",\",\";\",,,{1,2})", "#VALUE!"),
    ("=TEXTSPLIT(\"a,b\",\",\",,\"TRUE\")", "a,b"),
    ("=TEXTSPLIT(\"a,b\",\",\",,,\"1\")", "a,b"),
    ("=TEXTSPLIT(\"a,b;c\",\",\",\";\",,,A6)", "a,b;c,0"),
    ("=TEXTSPLIT(\"a,b;c\",\",\",\";\",FALSE,0,\"z\")", "a,b;c,z"),
    ("=TEXTSPLIT(\",\",\",\")", ","),
    ("=TEXTSPLIT(\",\",\",\",,TRUE)", "#VALUE!"), // Excel #CALC! (Calcula has no #CALC!)
    ("=TEXTSPLIT(\";\",\",\",\";\",TRUE)", "#VALUE!"), // Excel #CALC! (Calcula has no #CALC!)
    ("=TEXTSPLIT(\"a,b\",\",\",,TRUE,,1/0)", "a,b"),
    ("=TEXTSPLIT(\"ab\",\"b\")", "a,"),
    ("=TEXTSPLIT(TRUE,\"R\")", "T,UE"),
    ("=TEXTSPLIT(\"a,b,c;d\",\",\",\";\",,,\"\")", "a,b,c;d,,"),
    ("=TEXTSPLIT(\"abc\",{\"b\",\"bc\"})", "a,"),
    ("=TEXTSPLIT(\"abc\",{\"bc\",\"b\"})", "a,"),
    ("=TEXTSPLIT(\"a1b\",B1)", "a1b"),
];

#[test]
fn text_before_after_and_split_answer_as_excel_does() {
    let mut wrong = Vec::new();
    for (formula, expected) in EXCEL {
        let got = shown(&typed(formula));
        if &got != expected {
            wrong.push(format!("{formula}: Excel {expected:?}, Calcula {got:?}"));
        }
    }
    assert!(wrong.is_empty(), "{} of {} disagree:
{}", wrong.len(), EXCEL.len(), wrong.join("
"));
}

/// The headline case, on its own so a failure names it: a delimiter ARRAY is
/// a set of alternatives, never lifted over.
#[test]
fn a_delimiter_array_is_a_set_of_alternatives() {
    assert_eq!(shown(&typed("=TEXTBEFORE(\"a-b+c\",{\"-\",\"+\"})")), "a");
    assert_eq!(shown(&typed("=TEXTAFTER(\"a-b+c\",{\"-\",\"+\"},-1)")), "c");
    assert_eq!(shown(&typed("=TEXTSPLIT(\"a-b+c\",{\"-\",\"+\"})")), "a,b,c");
}
