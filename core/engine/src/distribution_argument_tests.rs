//! FILENAME: core/engine/src/distribution_argument_tests.rs
//! PURPOSE: The probability distributions read their arguments the way Excel
//! does -- an error argument propagates, the `cumulative` flag is a logical,
//! type errors outrank domain errors, arrays lift -- and ERF / ERFC and the
//! inverse distributions are exact to Excel's digits.
//!
//! [LIVE] Excel 16 (lane formc, 2026-11-05, SCRATCH/formc/p1.json, p2.json): a
//! fresh Excel 16 instance's new workbook, each formula typed (`Formula2`) into
//! column J, its `Value2` read back with 17 significant digits. The sheet below
//! is that probe sheet's column A (Excel's A10, the text "2", is this A2; its
//! text "1.5" is not used here because the probe ran under sv-SE, where "1.5"
//! is no number).
//!
//! WHAT WAS WRONG. Every distribution read its arguments through `as_number`,
//! which answers `None` for an error exactly as for the text "x": `=NORMSDIST(1/0)`
//! was #VALUE! where Excel says #DIV/0!, and none of the family lifted over an
//! array (`=SUM(NORM.S.DIST({1,2},TRUE))` #VALUE!). The `cumulative` flag was
//! TRUE only for TRUE or a non-zero number, so "x", "TRUE" and an error all
//! silently meant FALSE. `ERF`/`ERFC` were a 1.5e-7 approximation, and the T,
//! F, chi-square and gamma inverses bisected below a fixed bound, so
//! `T.INV.2T(0.0001,1)` was about 1000 where Excel says 6366.19767131594.

use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

/// A1 1.5, A2 the TEXT "2", A3 blank, A4 TRUE, A5 the text "x", A6 a stored
/// #DIV/0!, A7 a stored #N/A, A8 the text "TRUE"; B1 0.5, B2 FALSE.
fn sheet() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.5));
    g.set_cell(1, 0, Cell::new_text("2".to_string()));
    g.set_cell(3, 0, Cell::new_boolean(true));
    g.set_cell(4, 0, Cell::new_text("x".to_string()));
    let mut div0 = Cell::new_number(0.0);
    div0.value = CellValue::Error(CellError::Div0);
    g.set_cell(5, 0, div0);
    let mut na = Cell::new_number(0.0);
    na.value = CellValue::Error(CellError::NA);
    g.set_cell(6, 0, na);
    g.set_cell(7, 0, Cell::new_text("TRUE".to_string()));
    g.set_cell(0, 1, Cell::new_number(0.5));
    g.set_cell(1, 1, Cell::new_boolean(false));
    g
}

fn eval(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("{formula} must parse: {e:?}"));
    Evaluator::new(grid).evaluate(&ast)
}

fn number(grid: &Grid, formula: &str) -> f64 {
    match eval(grid, formula) {
        EvalResult::Number(n) => n,
        other => panic!("{formula} must be a number, got {other:?}"),
    }
}

/// Agreement to `rel` relative (absolute below 1e-300).
fn assert_close(formula: &str, got: f64, excel: f64, rel: f64) {
    let err = if excel == 0.0 { got.abs() } else { ((got - excel) / excel).abs() };
    assert!(err <= rel, "{formula}: Calcula {got:e}, [LIVE] Excel {excel:e} (relative error {err:e})");
}

// ---------------------------------------------------------------------------
// NEW-dist-error-args: errors, types and the cumulative flag
// ---------------------------------------------------------------------------

/// [LIVE] Excel 16's error for each formula.
const EXCEL_ERRORS: &[(&str, CellError)] = &[
    ("=NORM.S.DIST(1/0,TRUE)", CellError::Div0),
    ("=NORM.S.DIST(NA(),TRUE)", CellError::NA),
    ("=NORM.S.DIST(\"x\",TRUE)", CellError::Value),
    ("=NORM.S.DIST(\"\",TRUE)", CellError::Value),
    ("=NORM.S.DIST(A6,TRUE)", CellError::Div0),
    ("=NORM.S.DIST(A7,TRUE)", CellError::NA),
    ("=NORM.S.DIST(A5,TRUE)", CellError::Value),
    ("=NORM.S.DIST(1,1/0)", CellError::Div0),
    ("=NORM.S.DIST(1,\"x\")", CellError::Value),
    ("=NORM.S.DIST(1,\"1\")", CellError::Value),
    ("=NORM.S.DIST(1,\"\")", CellError::Value),
    ("=NORM.S.DIST(1,A5)", CellError::Value),
    ("=NORM.S.DIST(1,A2)", CellError::Value),
    ("=NORM.DIST(1/0,0,1,TRUE)", CellError::Div0),
    ("=NORM.DIST(1,NA(),1,TRUE)", CellError::NA),
    ("=NORM.DIST(1,0,\"x\",TRUE)", CellError::Value),
    ("=NORM.DIST(1,0,1,1/0)", CellError::Div0),
    ("=NORM.DIST(NA(),1/0,1,TRUE)", CellError::NA),
    ("=NORM.DIST(1,0,-1,1/0)", CellError::Div0),
    ("=NORM.DIST(1,0,-1,\"x\")", CellError::Value),
    ("=NORM.DIST(1,1/0,-1,TRUE)", CellError::Div0),
    ("=NORM.DIST(1,0,0,NA())", CellError::NA),
    // Left to right, an error and an unreadable argument alike.
    ("=NORM.DIST(\"x\",NA(),1,TRUE)", CellError::Value),
    ("=CHISQ.DIST(-1,\"x\",TRUE)", CellError::Value),
    ("=BINOM.DIST(11,10,\"x\",TRUE)", CellError::Value),
    ("=T.DIST(1/0,5,TRUE)", CellError::Div0),
    ("=T.DIST(1,\"x\",TRUE)", CellError::Value),
    ("=T.DIST(1,0,1/0)", CellError::Div0),
    ("=BINOM.DIST(1/0,10,0.5,FALSE)", CellError::Div0),
    ("=BINOM.DIST(3,NA(),0.5,FALSE)", CellError::NA),
    ("=BINOM.DIST(3,10,0.5,\"x\")", CellError::Value),
    ("=GAMMA.DIST(1/0,2,1,TRUE)", CellError::Div0),
    ("=CHISQ.DIST(1/0,2,TRUE)", CellError::Div0),
    ("=F.DIST(1/0,2,3,TRUE)", CellError::Div0),
    ("=POISSON.DIST(NA(),2,TRUE)", CellError::NA),
    ("=NORMSDIST(1/0)", CellError::Div0),
    ("=NORMSDIST(A6)", CellError::Div0),
    ("=NORMSDIST(A5)", CellError::Value),
    ("=TDIST(1/0,10,1)", CellError::Div0),
    ("=TDIST(1,10,1/0)", CellError::Div0),
    ("=CHIDIST(1/0,2)", CellError::Div0),
    ("=FDIST(NA(),2,3)", CellError::NA),
    ("=POISSON(1/0,2,TRUE)", CellError::Div0),
    ("=NORMDIST(1/0,0,1,TRUE)", CellError::Div0),
    ("=LOGNORMDIST(1/0,0,1)", CellError::Div0),
    ("=NORM.INV(1/0,0,1)", CellError::Div0),
    ("=NORM.S.INV(A4)", CellError::Num),
    ("=T.INV(1/0,5)", CellError::Div0),
    ("=CHISQ.INV(NA(),2)", CellError::NA),
    ("=F.INV(\"x\",2,3)", CellError::Value),
    ("=BETA.DIST(1/0,2,3,TRUE)", CellError::Div0),
    ("=BETA.DIST(0.5,2,3,TRUE,1/0)", CellError::Div0),
    ("=BETA.DIST(0.5,2,3,TRUE,0,NA())", CellError::NA),
    ("=BETA.DIST(0.5,2,3,TRUE,\"x\")", CellError::Value),
    ("=EXPON.DIST(1/0,1,TRUE)", CellError::Div0),
    ("=WEIBULL.DIST(NA(),1,1,TRUE)", CellError::NA),
    ("=LOGNORM.DIST(1/0,0,1,TRUE)", CellError::Div0),
    ("=HYPGEOM.DIST(1/0,4,5,10,FALSE)", CellError::Div0),
    ("=NEGBINOM.DIST(1/0,2,0.5,FALSE)", CellError::Div0),
    ("=GAMMA(1/0)", CellError::Div0),
    ("=GAMMALN(1/0)", CellError::Div0),
    ("=GAMMALN.PRECISE(1/0)", CellError::Div0),
    ("=CONFIDENCE.NORM(1/0,1,10)", CellError::Div0),
    ("=CONFIDENCE.T(1/0,1,10)", CellError::Div0),
    ("=ERF(1/0)", CellError::Div0),
    ("=ERF(0.5,1/0)", CellError::Div0),
    ("=ERFC(NA())", CellError::NA),
    ("=ERF.PRECISE(1/0)", CellError::Div0),
    ("=ERFC.PRECISE(NA())", CellError::NA),
    ("=FISHER(1/0)", CellError::Div0),
    ("=FISHERINV(1/0)", CellError::Div0),
    ("=PHI(1/0)", CellError::Div0),
    ("=GAUSS(1/0)", CellError::Div0),
    ("=STANDARDIZE(1/0,0,1)", CellError::Div0),
    ("=BETA.INV(1/0,2,3)", CellError::Div0),
    ("=GAMMA.INV(1/0,2,1)", CellError::Div0),
    ("=LOGNORM.INV(1/0,0,1)", CellError::Div0),
    ("=BINOM.INV(1/0,0.5,0.5)", CellError::Div0),
    ("=BINOM.DIST.RANGE(1/0,0.5,1)", CellError::Div0),
    ("=T.DIST.2T(1/0,2)", CellError::Div0),
    ("=T.DIST.RT(1/0,2)", CellError::Div0),
    ("=CHISQ.DIST.RT(1/0,2)", CellError::Div0),
    ("=F.DIST.RT(1/0,2,3)", CellError::Div0),
    ("=F.INV.RT(1/0,2,3)", CellError::Div0),
    ("=T.INV.2T(1/0,2)", CellError::Div0),
    ("=CHISQ.INV.RT(1/0,2)", CellError::Div0),
    ("=CONFIDENCE(1/0,1,10)", CellError::Div0),
    ("=CRITBINOM(1/0,0.5,0.5)", CellError::Div0),
    // ERF and its siblings take no logical, and no multi-cell range.
    ("=ERF(\"x\")", CellError::Value),
    ("=ERF(TRUE)", CellError::Value),
    ("=ERFC(TRUE)", CellError::Value),
    ("=ERFC(A4)", CellError::Value),
    ("=ERF.PRECISE(A4)", CellError::Value),
    ("=ERFC.PRECISE(A4)", CellError::Value),
    ("=ERF(1,TRUE)", CellError::Value),
    ("=ERF(1,A4)", CellError::Value),
    ("=ERF(,1)", CellError::NA),
    ("=ERF(B1:B2)", CellError::Value),
    ("=FISHER(TRUE)", CellError::Num),
];

#[test]
fn a_distribution_reports_the_error_its_argument_carries() {
    let g = sheet();
    for (formula, excel) in EXCEL_ERRORS {
        assert_eq!(eval(&g, formula), EvalResult::Error(excel.clone()), "{formula}: [LIVE] Excel {excel:?}");
    }
}

/// [LIVE] Excel 16's value for each formula.
const EXCEL_VALUES: &[(&str, f64)] = &[
    ("=NORM.S.DIST(A3,TRUE)", 0.5),
    ("=NORM.S.DIST(,TRUE)", 0.5),
    ("=NORM.S.DIST(TRUE,TRUE)", 0.841344746068543),
    ("=NORM.S.DIST(A4,TRUE)", 0.841344746068543),
    ("=NORM.S.DIST(1,\"TRUE\")", 0.841344746068543),
    ("=NORM.S.DIST(1,\"True\")", 0.841344746068543),
    ("=NORM.S.DIST(1,A8)", 0.841344746068543),
    ("=NORM.S.DIST(1,A3)", 0.24197072451914337),
    ("=NORM.S.DIST(1,\"false\")", 0.24197072451914337),
    ("=NORM.S.DIST(1,B2)", 0.24197072451914337),
    ("=NORM.S.DIST(1,2)", 0.841344746068543),
    ("=NORM.S.DIST(A2,TRUE)", 0.97724986805182079),
    ("=NORM.S.DIST(\"2\",TRUE)", 0.97724986805182079),
    ("=NORM.DIST(A4,0,1,TRUE)", 0.841344746068543),
    ("=T.DIST(A4,5,TRUE)", 0.81839126617543867),
    ("=T.DIST(A2,5,TRUE)", 0.94903026058507078),
    ("=BINOM.DIST(\"3\",10,0.5,FALSE)", 0.11718750000000003),
    ("=BINOM.DIST(A4,10,0.5,FALSE)", 0.0097656250000000017),
    ("=BINOM.DIST(A2,10,0.5,FALSE)", 0.043945312499999972),
    ("=GAMMA.DIST(A4,2,1,TRUE)", 0.26424111765711522),
    ("=GAMMA.DIST(A3,2,1,TRUE)", 0.0),
    ("=GAMMA.DIST(A2,2,1,TRUE)", 0.59399415029016189),
    ("=CHISQ.DIST(A4,2,TRUE)", 0.39346934028736658),
    ("=POISSON.DIST(A4,2,TRUE)", 0.40600584970983811),
    ("=POISSON.DIST(2,2,A8)", 0.6766764161830634),
    ("=NORMSDIST(A4)", 0.841344746068543),
    ("=NORMSDIST(TRUE)", 0.841344746068543),
    ("=NORMSDIST(A3)", 0.5),
    ("=NORMSDIST(A2)", 0.97724986805182079),
    ("=TDIST(A4,10,1)", 0.17044656615102993),
    ("=BINOMDIST(A4,10,0.5,FALSE)", 0.0097656250000000017),
    ("=FISHERINV(A4)", 0.76159415595576485),
    ("=PHI(A4)", 0.24197072451914337),
    ("=GAUSS(A4)", 0.34134474606854304),
    ("=STANDARDIZE(A4,0,1)", 1.0),
    ("=GAMMA(A4)", 1.0),
    ("=GAMMA(A2)", 1.0),
    ("=GAMMALN(A4)", 0.0),
    ("=CONFIDENCE.NORM(0.05,A4,10)", 0.61979503230456146),
    ("=ERF(A2)", 0.99532226501895271),
    ("=ERF(\"2\")", 0.99532226501895271),
    ("=ERF(A2,1)", -0.15262147206923782),
    ("=ERF(A3,1)", 0.84270079294971489),
    ("=ERF(A3)", 0.0),
    // The family LIFTS over an array, and over a range.
    ("=SUM(NORM.S.DIST({1,2},TRUE))", 1.8185946141203639),
    ("=COLUMNS(NORM.S.DIST({1,2},TRUE))", 2.0),
    ("=SUM(NORM.DIST({1;2},0,1,{TRUE,FALSE}))", 2.114556305152695),
    ("=COLUMNS(NORM.DIST({1;2},0,1,{TRUE,FALSE}))", 2.0),
    ("=SUM(BINOM.DIST({1,2,3},10,0.5,FALSE))", 0.1708984375),
    ("=SUM(ERF({0.5,1}))", 1.3632006707627613),
    ("=SUM(NORMSDIST({1,2}))", 1.8185946141203639),
    ("=SUM(NORM.S.DIST(B1:B2,TRUE))", 1.1914624612740132),
    ("=SUM(ERF(B1:B1))", 0.52049987781304652),
    ("=ERROR.TYPE(INDEX(NORM.S.DIST({1,\"x\",1},TRUE),1,2))", 3.0),
];

#[test]
fn a_distribution_coerces_its_arguments_as_excel_does_and_lifts_over_arrays() {
    let g = sheet();
    for (formula, excel) in EXCEL_VALUES {
        assert_close(formula, number(&g, formula), *excel, 1e-13);
    }
}

// ---------------------------------------------------------------------------
// NEW-erf-precision
// ---------------------------------------------------------------------------

const EXCEL_ERF: &[(&str, f64)] = &[
    ("=ERF(0.1)", 0.11246291601828493),
    ("=ERF(0.5)", 0.52049987781304652),
    ("=ERF(1)", 0.84270079294971489),
    ("=ERF(1.5)", 0.96610514647531076),
    ("=ERF(2)", 0.99532226501895271),
    ("=ERF(3)", 0.99997790950300136),
    ("=ERF(-0.7)", -0.67780119383741844),
    ("=ERF(0.00001)", 1.1283791670579E-05),
    ("=ERF(0.5,1.5)", 0.44560526866226424),
    ("=ERF(-3,2)", 1.9953001745219541),
    ("=ERF(6)", 1.0),
    ("=ERF(1.9)", 0.99279042923525751),
    ("=ERF(2.1)", 0.997020533343667),
    ("=ERFC(0.1)", 0.887537083981715),
    ("=ERFC(1)", 0.15729920705028513),
    ("=ERFC(1.9)", 0.0072095707647425282),
    ("=ERFC(2)", 0.0046777349810472645),
    ("=ERFC(2.1)", 0.002979466656332985),
    ("=ERFC(3)", 2.2090496998585441E-05),
    ("=ERFC(5)", 1.5374597944280339E-12),
    ("=ERFC(10)", 2.0884875837625446E-45),
    ("=ERFC(26)", 5.6631924088561443E-296),
    ("=ERFC(27)", 0.0),
    ("=ERFC(-1)", 1.8427007929497148),
    ("=ERFC(0)", 1.0),
    ("=ERF.PRECISE(0.8)", 0.74210096470766063),
    ("=ERFC.PRECISE(2.5)", 0.00040695201744495886),
];

#[test]
fn erf_and_erfc_agree_with_excel_to_its_last_digits() {
    let g = sheet();
    for (formula, excel) in EXCEL_ERF {
        assert_close(formula, number(&g, formula), *excel, 2e-14);
    }
}

// ---------------------------------------------------------------------------
// NEW-inverse-clamp
// ---------------------------------------------------------------------------

const EXCEL_INVERSES: &[(&str, f64)] = &[
    ("=T.INV.2T(0.0001,1)", 6366.1976713159365),
    ("=T.INV.2T(1E-10,1)", 6366197723.6758127),
    ("=T.INV(0.0001,1)", -3183.0987571181508),
    ("=T.INV(0.9999,1)", 3183.0987571185015),
    ("=T.INV(1E-10,2)", -70710.678108048145),
    ("=T.INV.2T(0.001,2)", 31.599054576443621),
    ("=TINV(0.0001,1)", 6366.1976713159365),
    ("=T.INV(0.05,100)", -1.6602343260853425),
    ("=T.INV(1E-15,1)", -318309886183790.69),
    ("=T.INV(0.75,1)", 1.0000000000000002),
    ("=T.INV(0.9,1.5)", 3.0776835371752544),
    ("=T.INV.2T(0.5,1)", 1.0000000000000002),
    ("=T.INV(0.999999,3)", 103.29946777942901),
    ("=T.INV(1E-300,1)", -3.183098861837907E+299),
    ("=T.INV.2T(1E-300,1)", 6.366197723675814E+299),
    ("=CONFIDENCE.T(0.00001,1,2)", 45015.815804152895),
    ("=F.INV(0.9999,1,1)", 40528472.790277414),
    ("=F.INV(0.99999,1,1)", 4052847345.0637393),
    ("=F.INV.RT(0.000001,1,1)", 405284734568.68433),
    ("=F.INV.RT(1E-10,2,2)", 9999999999.0000038),
    ("=F.INV(0.999,1,2)", 998.5002501250616),
    ("=FINV(1E-8,1,1)", 4052847345693505.0),
    ("=F.INV(1E-10,5,5)", 5.0819688099252479E-05),
    ("=F.INV(0.5,1,1)", 0.99999999999999989),
    ("=F.INV(0.999999,10,1)", 605621337855.42883),
    ("=F.INV.RT(1E-12,1,3)", 169426169.12748393),
    ("=CHISQ.INV(0.999999,1)", 23.928126976879469),
    ("=CHISQ.INV.RT(1E-10,100)", 217.71420313830922),
    ("=CHISQ.INV(0.5,1000)", 999.333412403381),
    ("=CHISQ.INV(0.99,10000)", 10331.933577929449),
    ("=CHISQ.INV(1E-10,1)", 1.5707963267948968E-20),
    ("=GAMMA.INV(0.999999,1,1)", 13.815510557935518),
    ("=GAMMA.INV(0.9999999999,0.1,1)", 18.119637703108019),
    ("=GAMMA.INV(0.999999,100,10)", 1549.1904599496158),
];

/// EXCEL'S OWN INVERSE IS LOOSE HERE: [LIVE] `CHISQ.INV.RT(1E-12,1)` is
/// 50.844171332449172, whose upper tail is 9.99978e-13, not 1e-12 (erfc of
/// sqrt(x/2), computed to 1e-16); the exact quantile is 50.8441279118182.
/// Calcula keeps the exact one: within 1e-6 of Excel, and its own tail is the
/// probability asked for.
#[test]
fn an_extreme_chi_square_quantile_is_exact_where_excel_is_within_1e_6() {
    let g = sheet();
    assert_close("=CHISQ.INV.RT(1E-12,1)", number(&g, "=CHISQ.INV.RT(1E-12,1)"), 50.844171332449172, 1e-6);
    assert_close("=CHISQ.DIST.RT(CHISQ.INV.RT(1E-12,1),1)", number(&g, "=CHISQ.DIST.RT(CHISQ.INV.RT(1E-12,1),1)"), 1e-12, 1e-12);
}

#[test]
fn the_inverse_distributions_reach_every_quantile_excel_does() {
    let g = sheet();
    let mut wrong = Vec::new();
    for (formula, excel) in EXCEL_INVERSES {
        let got = number(&g, formula);
        let err = ((got - excel) / excel).abs();
        if !(err <= 1e-12) {
            wrong.push(format!("{formula}: Calcula {got:e}, [LIVE] Excel {excel:e} (relative error {err:e})"));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
