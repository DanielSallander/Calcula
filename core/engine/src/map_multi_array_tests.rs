//! FILENAME: core/engine/src/map_multi_array_tests.rs
//! PURPOSE: MAP over SEVERAL arrays, as Excel's (lane formd,
//! NEW-map-multi-array).
//!
//! [LIVE] Excel 16, 2026-11-05 (SCRATCH/formd/p1.json, p2.json): a fresh
//! Excel 16 instance's new workbook with A1:A3 = 1,2,3, B1:B3 = 10,20,30 and
//! A6 blank; each formula typed (`Formula2`) into column J and its spill read
//! back cell by cell. Calcula took exactly one array: every MAP with two or
//! more was #VALUE!.

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheet() -> Grid {
    let mut grid = Grid::new();
    for (row, (a, b)) in [(1.0, 10.0), (2.0, 20.0), (3.0, 30.0)].into_iter().enumerate() {
        grid.set_cell(row as u32, 0, Cell::new_number(a));
        grid.set_cell(row as u32, 1, Cell::new_number(b));
    }
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

/// The result as Excel's spill reads: rows joined by `;`, cells by `,`.
fn shown(v: &EvalResult) -> String {
    match v {
        EvalResult::Array(rows) => {
            let nested = rows.iter().any(|r| matches!(r, EvalResult::Array(_)));
            if nested {
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

/// [LIVE] Excel 16's spill for each formula.
const EXCEL: &[(&str, &str)] = &[
    ("=MAP(A1:A3,B1:B3,LAMBDA(a,b,a+b))", "11;22;33"),
    ("=MAP({1,2,3},{10,20,30},LAMBDA(a,b,a+b))", "11,22,33"),
    ("=MAP({1,2;3,4},{10,20;30,40},LAMBDA(a,b,a*b))", "10,40;90,160"),
    ("=MAP({1,2},{3,4},{5,6},LAMBDA(a,b,c,a+b+c))", "9,12"),
    ("=MAP({1,2},{1,2},{1,2},{1,2},LAMBDA(a,b,c,d,a+b+c+d))", "4,8"),
    ("=MAP({1,2},{3,4},LAMBDA(a,b,a&\"-\"&b))", "1-3,2-4"),
    ("=MAP({1,2},{3,4},LAMBDA(a,b,SUM(a,b)))", "4,6"),
    ("=MAP({1,2},{3,4},LAMBDA(a,b,ROWS(b)))", "1,1"),
    ("=MAP({1,2},{3,4},LAMBDA(a,b,IF(a=1,1/0,b)))", "#DIV/0!,4"),
    // Nothing broadcasts: a position an array does not reach is #N/A.
    ("=MAP({1,2,3},{10,20},LAMBDA(a,b,a+b))", "11,22,#N/A"),
    ("=MAP(10,{1,2,3},LAMBDA(a,b,a+b))", "11,#N/A,#N/A"),
    ("=MAP({1},{3,4},LAMBDA(a,b,a+b))", "4,#N/A"),
    ("=MAP({1;2},{1,2},LAMBDA(a,b,a+b))", "2,#N/A;#N/A,#N/A"),
    ("=MAP({1,2,3},{1;2},LAMBDA(a,b,a+b))", "2,#N/A,#N/A;#N/A,#N/A,#N/A"),
    ("=MAP(A1:B1,A1:A2,LAMBDA(a,b,a+b))", "2,#N/A;#N/A,#N/A"),
    ("=MAP(A1:A3,B1:B2,LAMBDA(a,b,a+b))", "11;22;#N/A"),
    ("=MAP({1,2},{3,4,5;6,7,8},LAMBDA(a,b,a+b))", "4,6,#N/A;#N/A,#N/A,#N/A"),
    ("=MAP(A1:A2,A1,LAMBDA(a,b,a+b))", "2;#N/A"),
    ("=MAP(SEQUENCE(2),{1;2},LAMBDA(a,b,a+b))", "2;4"),
    // A later array may be a one-cell reference or a one-element array.
    ("=MAP({1,2},A1,LAMBDA(a,b,a+b))", "2,#N/A"),
    ("=MAP({1,2},{5},LAMBDA(a,b,a+b))", "6,#N/A"),
    ("=MAP({1,2},A6,LAMBDA(a,b,ISBLANK(b)))", "TRUE,#N/A"),
    ("=MAP(A6,{1,2},LAMBDA(a,b,ISBLANK(a)))", "TRUE,#N/A"),
    // The one-array MAP is unchanged.
    ("=MAP(A1:A3,LAMBDA(a,a*2))", "2;4;6"),
];

/// [LIVE] Excel 16's errors.
const EXCEL_ERRORS: &[(&str, CellError)] = &[
    // A LATER array that is a scalar (or an error value) is #VALUE!.
    ("=MAP({1,2,3},10,LAMBDA(a,b,a+b))", CellError::Value),
    ("=MAP({1,2},\"x\",LAMBDA(a,b,a&b))", CellError::Value),
    ("=MAP({1,2},TRUE,LAMBDA(a,b,a))", CellError::Value),
    ("=MAP({1,2},LET(x,5,x),LAMBDA(a,b,a+b))", CellError::Value),
    ("=MAP({1,2},1/0,LAMBDA(a,b,a))", CellError::Value),
    ("=MAP({1,2},xyz,LAMBDA(a,b,a))", CellError::Value),
    // The FIRST array's error is its own.
    ("=MAP(1/0,{1,2},LAMBDA(a,b,a))", CellError::Div0),
    ("=MAP(xyz,{1,2},LAMBDA(a,b,a))", CellError::Name),
    // No callable, or the wrong parameter count.
    ("=MAP({1,2},{3,4},xyz)", CellError::Value),
    ("=MAP({1,2},{3,4},LAMBDA(a,a))", CellError::Value),
    ("=MAP({1,2},{3,4},LAMBDA(a,b,c,a))", CellError::Value),
];

#[test]
fn map_takes_several_arrays_position_by_position_as_excel_does() {
    let mut wrong = Vec::new();
    for (formula, expected) in EXCEL {
        let got = shown(&typed(formula));
        if &got != expected {
            wrong.push(format!("{formula}: Excel {expected}, Calcula {got}"));
        }
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn map_refuses_a_scalar_later_array_and_a_mismatched_lambda_as_excel_does() {
    let mut wrong = Vec::new();
    for (formula, expected) in EXCEL_ERRORS {
        match typed(formula) {
            EvalResult::Error(e) if &e == expected => {}
            other => wrong.push(format!("{formula}: Excel {expected:?}, Calcula {}", shown(&other))),
        }
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}
