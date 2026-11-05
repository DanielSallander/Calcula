//! FILENAME: core/engine/src/tail_precision_tests.rs
//! PURPOSE: T.TEST and BETA.INV keep the digits of a SMALL TAIL, as Excel's
//! do (lane formd, NEW-ttest-betainv-precision).
//!
//! [LIVE] Excel 16, 2026-11-05 (SCRATCH/formd/p1.json): a fresh Excel 16
//! instance's new workbook with G1:G10 = 1..10, H1:H10 = 31,33,32,35,34,36,
//! 38,37,40,39, K1:K10 = 1..10 and L1:L10 = 1.01,2.03,2.99,4.02,5,6.01,6.98,
//! 8.02,9,10.01; each formula typed (`Formula2`) into column J and its `Value2`
//! read back with 17 significant digits.
//!
//! T.TEST computed its p-value as `1 - t_cdf(|t|)`, which keeps no digit of a
//! tail below 1e-16 and one digit near 1e-15; BETA.INV bisected 100 times on
//! the LOWER CDF, so a probability near 1 was compared against 1 - (tiny).

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheet() -> Grid {
    let g = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
    let h = [31.0, 33.0, 32.0, 35.0, 34.0, 36.0, 38.0, 37.0, 40.0, 39.0];
    let l = [1.01, 2.03, 2.99, 4.02, 5.0, 6.01, 6.98, 8.02, 9.0, 10.01];
    let mut grid = Grid::new();
    for row in 0..10 {
        grid.set_cell(row as u32, 6, Cell::new_number(g[row]));
        grid.set_cell(row as u32, 7, Cell::new_number(h[row]));
        grid.set_cell(row as u32, 10, Cell::new_number(g[row]));
        grid.set_cell(row as u32, 11, Cell::new_number(l[row]));
    }
    grid
}

fn typed(formula: &str) -> EvalResult {
    let cell = crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"));
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let grid = sheet();
    Evaluator::new(&grid).evaluate(ast)
}

/// [LIVE] Excel 16's value for each formula, to 17 significant digits.
const EXCEL_VALUES: &[(&str, f64)] = &[
    ("=T.TEST(G1:G10,H1:H10,2,1)", 4.7974960608904026E-15),
    ("=T.TEST(G1:G10,H1:H10,1,1)", 2.3987480304452013E-15),
    ("=T.TEST(G1:G10,H1:H10,2,2)", 1.6330229407111961E-14),
    ("=T.TEST(G1:G10,H1:H10,2,3)", 1.6330229407111961E-14),
    ("=T.TEST(G1:G10,H1:H10,1,3)", 8.16511470355598E-15),
    ("=T.TEST(G1:G5,H1:H10,2,3)", 8.8191175202395983E-13),
    ("=T.TEST(K1:K10,L1:L10,2,1)", 0.17268508962890214),
    ("=T.TEST(K1:K10,L1:L10,2,2)", 0.99592987489565765),
    ("=T.TEST(K1:K10,L1:L10,2,3)", 0.99592987495441032),
    ("=T.TEST(K1:K10,L1:L10,1,2)", 0.49796493744782883),
    ("=T.TEST(G1:G10,G1:G10,2,2)", 1.0),
    ("=T.TEST(G1:G10,K1:K10*1.001,2,3)", 0.99680526496393851),
    // `tails` and `type` are truncated.
    ("=T.TEST(G1:G10,H1:H10,2.7,3.9)", 1.6330229407111961E-14),
    ("=TTEST(G1:G10,H1:H10,2,3)", 1.6330229407111961E-14),
    ("=BETA.INV(0.999999999,2,3)", 0.99936994022152381),
    ("=BETA.INV(0.999999999999,2,3)", 0.99993700341987779),
    ("=BETA.INV(0.99999999999999,2,3)", 0.99998643148281086),
    ("=BETA.INV(0.999999999999999,5,5)", 0.9996198399094679),
    ("=BETA.INV(0.9999999999999,0.5,0.5)", 1.0),
    ("=BETA.INV(1E-12,2,3)", 4.082484015750325E-07),
    ("=BETA.INV(0.5,2,3)", 0.38572756813238951),
    ("=BETA.INV(0.99,0.1,10)", 0.15308042377769782),
    ("=BETA.INV(0.01,10,0.1)", 0.84691957622230207),
    ("=BETA.INV(0.5,2,3,1,5)", 2.542910272529558),
    ("=BETA.INV(0.9,1,1)", 0.9),
    ("=BETA.INV(0.25,0.5,0.5)", 0.14644660940672621),
    ("=BETA.INV(0.000001,1000,1000)", 0.44699826807439097),
    ("=BETA.INV(0.999999,1000,1000)", 0.55300173192554469),
    ("=BETAINV(0.999999999999,2,3)", 0.99993700341987779),
];

/// [LIVE] Excel 16's errors.
const EXCEL_ERRORS: &[(&str, CellError)] = &[
    // Every difference is 0.5: a zero standard error.
    ("=T.TEST(G1:G10,G1:G10+0.5,2,1)", CellError::Div0),
    ("=BETA.INV(0,2,3)", CellError::Num),
    ("=BETA.INV(1,2,3)", CellError::Num),
    ("=BETAINV(0,2,3)", CellError::Num),
    ("=BETAINV(1,2,3)", CellError::Num),
    ("=BETA.INV(0.5,2,3,5,1)", CellError::Num),
    ("=BETA.INV(0.5,2,3,1,1)", CellError::Num),
    ("=BETA.INV(0.5,2,3,1)", CellError::Num),
];

/// Every value agrees with Excel's to 1e-9 RELATIVE -- which a tail computed
/// as a difference from 1 cannot (`1 - t_cdf` gave 4.88e-15 for Excel's
/// 4.7975e-15, a 2% error).
#[test]
fn small_tails_keep_their_digits_as_excel_s_do() {
    let mut wrong = Vec::new();
    for (formula, expected) in EXCEL_VALUES {
        match typed(formula) {
            EvalResult::Number(n) => {
                let tolerance = expected.abs() * 1e-9;
                if (n - expected).abs() > tolerance {
                    wrong.push(format!("{formula}: Excel {expected:e}, Calcula {n:e}"));
                }
            }
            other => wrong.push(format!("{formula}: Excel {expected:e}, Calcula {other:?}")),
        }
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn degenerate_tests_and_out_of_domain_quantiles_are_excel_s_errors() {
    let mut wrong = Vec::new();
    for (formula, expected) in EXCEL_ERRORS {
        match typed(formula) {
            EvalResult::Error(e) if &e == expected => {}
            other => wrong.push(format!("{formula}: Excel {expected:?}, Calcula {other:?}")),
        }
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}
