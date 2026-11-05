//! FILENAME: core/engine/src/legacy_stats_tests.rs
//! PURPOSE: Excel's COMPATIBILITY statistical functions (`TDIST`, `NORMSDIST`,
//! `FDIST`, `BETADIST`, ...) are their own functions: typed, each keeps its
//! own name and evaluates to Excel's value with its OWN arguments.
//!
//! [LIVE] Excel 16, lane legacystats 2026-11-05 (SCRATCH/legacystats/p1.json):
//! a fresh Excel 16 instance's new workbook, A1:A6 = 2,4,4,5,7,9 and
//! B1:B6 = 3,5,8,6,10,12, each formula typed (`Formula2`) into column J, its
//! `Value2` read back with 17 significant digits and its `.Formula` (the
//! formula bar) read back unchanged.
//!
//! Calcula's parser stored each compatibility name under the MODERN function
//! (`TDIST` -> `T.DIST`, `NORMSDIST` -> `NORM.S.DIST`, ...), so the formula
//! came back renamed and was evaluated with the modern function's arguments:
//! `TDIST(1.5,10,1)` as `T.DIST(1.5,10,TRUE)` = 0.9177 (the LEFT tail; Excel
//! 0.0823), and `NORMSDIST(1.5)`, `FDIST(2,5,10)`, `LOGNORMDIST(2,0.5,1)`,
//! `HYPGEOMDIST(..)` and `NEGBINOMDIST(..)` as `#VALUE!` at the modern arity.
//! `POISSON`, `CONFIDENCE` and `ZTEST` were no functions at all (#NAME?).

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheet() -> Grid {
    let mut grid = Grid::new();
    for (row, (a, b)) in [(2.0, 3.0), (4.0, 5.0), (4.0, 8.0), (5.0, 6.0), (7.0, 10.0), (9.0, 12.0)].into_iter().enumerate() {
        grid.set_cell(row as u32, 0, Cell::new_number(a));
        grid.set_cell(row as u32, 1, Cell::new_number(b));
    }
    grid
}

/// The formula TYPED (the cell-entry ladder), evaluated, and the text the
/// formula bar shows for it (`=` and the rendered formula).
fn typed(formula: &str) -> (EvalResult, String) {
    let cell = crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"));
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let grid = sheet();
    let value = Evaluator::new(&grid).evaluate(ast);
    (value, format!("={}", cell.formula_string().expect("a formula cell")))
}

/// [LIVE] Excel 16's value for each formula, to 17 significant digits.
const EXCEL_VALUES: &[(&str, f64)] = &[
    ("=NORMSDIST(1.5)", 0.93319279873114191),
    ("=NORMSDIST(-0.7)", 0.24196365222307298),
    ("=NORMSINV(0.9)", 1.2815515655446006),
    ("=NORMDIST(1.2,0.5,2,TRUE)", 0.6368306511756191),
    ("=NORMDIST(1.2,0.5,2,FALSE)", 0.18762017345846896),
    ("=NORMINV(0.3,1,2)", -0.048801025416081778),
    ("=TDIST(1.5,10,1)", 0.082253663222720139),
    ("=TDIST(1.5,10,2)", 0.16450732644544028),
    ("=TDIST(1.5,10.7,1.9)", 0.082253663222720139),
    ("=TDIST(0,10,2)", 1.0),
    ("=TINV(0.1,10)", 1.812461122811676),
    ("=TTEST(A1:A6,B1:B6,2,2)", 0.22996564564717153),
    ("=FDIST(2,5,10)", 0.16419495089973882),
    ("=FDIST(2,5.9,10.9)", 0.16419495089973882),
    ("=FINV(0.05,5,10)", 3.325834530413013),
    ("=FTEST(A1:A6,B1:B6)", 0.53657477252679686),
    ("=CHIDIST(3,4)", 0.55782540037107464),
    ("=CHIDIST(3,4.9)", 0.55782540037107464),
    ("=CHIINV(0.2,4)", 5.9886166940042447),
    ("=CHITEST(A1:A3,B1:B3)", 0.28176928909495835),
    ("=BINOMDIST(3,10,0.4,FALSE)", 0.21499084800000007),
    ("=BINOMDIST(3,10,0.4,TRUE)", 0.38228060159999988),
    ("=CRITBINOM(10,0.4,0.5)", 4.0),
    ("=POISSON(3,2.5,TRUE)", 0.75757613313306593),
    ("=POISSON(3,2.5,FALSE)", 0.21376301724973648),
    ("=BETADIST(0.4,2,3)", 0.5248),
    ("=BETADIST(2,2,3,1,4)", 0.40740740740740733),
    ("=BETADIST(0.4,2,3,0)", 0.5248),
    ("=BETAINV(0.5,2,3)", 0.38572756813238951),
    ("=BETAINV(0.5,2,3,1,4)", 2.1571827043971687),
    ("=GAMMADIST(2,3,1.5,TRUE)", 0.15063144384932486),
    ("=GAMMADIST(2,3,1.5,FALSE)", 0.15620571147598628),
    ("=GAMMAINV(0.5,3,1.5)", 4.0110904705853407),
    ("=WEIBULL(2,1.5,3,TRUE)", 0.41977020402532705),
    ("=WEIBULL(2,1.5,3,FALSE)", 0.23687782228285617),
    ("=EXPONDIST(0.5,2,TRUE)", 0.63212055882855767),
    ("=EXPONDIST(0.5,2,FALSE)", 0.73575888234288467),
    ("=LOGNORMDIST(2,0.5,1)", 0.5765781482392448),
    ("=LOGINV(0.5,0.5,1)", 1.6487212707001282),
    ("=HYPGEOMDIST(2,5,10,30)", 0.35998484274346348),
    ("=HYPGEOMDIST(2.9,5.9,10.9,30.9)", 0.35998484274346348),
    ("=NEGBINOMDIST(3,5,0.4)", 0.0774144),
    ("=NEGBINOMDIST(3.9,5.9,0.4)", 0.0774144),
    ("=CONFIDENCE(0.05,2.5,50)", 0.69295191217483865),
    ("=CONFIDENCE(0.05,2.5,50.9)", 0.69295191217483865),
    ("=POISSON(3.9,2.5,TRUE)", 0.75757613313306593),
    ("=COVAR(A1:A6,B1:B6)", 6.4444444444444455),
    ("=PERCENTILE(A1:A6,0.3)", 4.0),
    ("=QUARTILE(A1:A6,1)", 4.0),
    ("=PERCENTRANK(A1:A6,4)", 0.2),
    ("=RANK(4,A1:A6)", 4.0),
    ("=MODE(A1:A6)", 4.0),
    ("=STDEV(A1:A6)", 2.4832774042918904),
    ("=STDEVP(A1:A6)", 2.2669117514559072),
    ("=VAR(A1:A6)", 6.1666666666666687),
    ("=VARP(A1:A6)", 5.1388888888888893),
    ("=ZTEST(A1:A6,4)", 0.12490872091797393),
    ("=ZTEST(A1:A6,4,2)", 0.076520942079409987),
    ("=Z.TEST(A1:A6,4)", 0.12490872091797393),
    ("=FORECAST(7,B1:B6,A1:A6)", 9.6324324324324326),
    ("=CEILING(2.3,0.5)", 2.5),
    ("=FLOOR(2.3,0.5)", 2.0),
    ("=CEILING(-2.3,-0.5)", -2.5),
    ("=FLOOR(-2.3,0.5)", -2.5),
    ("=STDEV.P(A1:A6)", 2.2669117514559072),
    ("=VAR.P(A1:A6)", 5.1388888888888893),
    ("=RANK.EQ(4,A1:A6)", 4.0),
    ("=PERCENTILE.INC(A1:A6,0.3)", 4.0),
    ("=QUARTILE.INC(A1:A6,1)", 4.0),
    ("=MODE.SNGL(A1:A6)", 4.0),
    ("=PERCENTRANK.INC(A1:A6,4)", 0.2),
    ("=GAMMALN.PRECISE(4.5)", 2.4537365708424423),
    ("=GAMMALN(4.5)", 2.4537365708424423),
    ("=FORECAST.LINEAR(7,B1:B6,A1:A6)", 9.6324324324324326),
    ("=COVARIANCE.P(A1:A6,B1:B6)", 6.4444444444444455),
    ("=CHISQ.DIST.RT(3,4)", 0.55782540037107464),
    ("=NORM.S.DIST(1.5,TRUE)", 0.93319279873114191),
    ("=T.DIST(1.5,10,TRUE)", 0.9177463367772799),
    ("=T.DIST.RT(1.5,10)", 0.082253663222720139),
    ("=F.DIST.RT(2,5,10)", 0.16419495089973882),
];

/// [LIVE] Excel 16's errors for the compatibility functions' own domains.
const EXCEL_ERRORS: &[(&str, CellError)] = &[
    ("=TDIST(-1,10,1)", CellError::Num),
    ("=TDIST(1.5,10,3)", CellError::Num),
    ("=TDIST(1.5,0.5,1)", CellError::Num),
    ("=FDIST(-1,5,10)", CellError::Num),
    ("=CHIDIST(-1,4)", CellError::Num),
    ("=BETADIST(5,2,3,1,4)", CellError::Num),
    ("=LOGNORMDIST(0,0.5,1)", CellError::Num),
    // SCRATCH/legacystats/p3.json: ZTEST over one value is #DIV/0! even with a
    // sigma, over none #N/A, and a sigma <= 0 is #NUM!.
    ("=ZTEST(A1,4)", CellError::Div0),
    ("=ZTEST(A1,4,2)", CellError::Div0),
    ("=ZTEST(E1:E3,4)", CellError::NA),
    ("=ZTEST(A1:A6,4,0)", CellError::Num),
    ("=ZTEST(A1:A6,4,-1)", CellError::Num),
    ("=ZTEST(A1:A6,\"x\")", CellError::Value),
    ("=NORMSDIST(\"x\")", CellError::Value),
    ("=TDIST(1.5,10,\"x\")", CellError::Value),
    // Excel has no POISSONDIST or CHISQDIST.
    ("=POISSONDIST(3,2.5,TRUE)", CellError::Name),
    ("=CHISQDIST(3,4,TRUE)", CellError::Name),
];

/// Close to Excel's 17-digit value: the distributions are numerical
/// approximations, so the agreement asked is 1e-12 relative (the 15 digits
/// a cell shows, to within the last three), not the last bit.
fn agrees(got: f64, excel: f64) -> bool {
    (got - excel).abs() <= 1e-12 * excel.abs().max(1.0)
}

/// SABOTAGE (legacystats-tdist): `TDIST` evaluated as `T.DIST` again -- fails
/// at the TDIST rows, 0.9177 against Excel's 0.0823. (legacystats-name):
/// NORMSDIST as NORM.S.DIST -- #VALUE!. (legacystats-gammacf): the upper
/// incomplete gamma's Lentz start back at 1e-30 -- CHIINV 140, GAMMAINV
/// 111.15. (legacystats-beta): no symmetry in the incomplete beta -- FINV
/// 10000. (legacystats-normcdf): the old Abramowitz-Stegun normal CDF --
/// NORMSDIST, NORMDIST, LOGNORMDIST, ZTEST off in the 8th digit.
/// (legacystats-ztest): ZTEST over one value no longer #DIV/0!.
#[test]
fn every_compatibility_function_gives_excels_value() {
    let mut wrong = Vec::new();
    for &(formula, excel) in EXCEL_VALUES {
        let (value, _) = typed(formula);
        match value {
            EvalResult::Number(n) if agrees(n, excel) => {}
            other => wrong.push(format!("  {formula}: Excel {excel}, Calcula {other:?}")),
        }
    }
    for (formula, excel) in EXCEL_ERRORS {
        let (value, _) = typed(formula);
        if value != EvalResult::Error(excel.clone()) {
            wrong.push(format!("  {formula}: Excel {excel:?}, Calcula {value:?}"));
        }
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S VALUE ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// [LIVE] Excel 16's formula bar shows each formula as typed: `=TDIST(..)`,
/// `=NORMSDIST(..)`, `=STDEV.P(..)`, `=FORECAST.LINEAR(..)`.
///
/// SABOTAGE (legacystats-name): `"NORMSDIST"` resolved to `NormSDist` again
/// -- fails here, `=NORM.S.DIST(1.5)` for `=NORMSDIST(1.5)`. (legacystats-alias):
/// `"STDEV.P"` resolved to `StdevP` again -- `=STDEVP(..)` for `=STDEV.P(..)`.
#[test]
fn every_compatibility_function_keeps_the_name_it_was_typed_with() {
    let mut renamed = Vec::new();
    for &(formula, _) in EXCEL_VALUES {
        let (_, shown) = typed(formula);
        if !shown.eq_ignore_ascii_case(formula) {
            renamed.push(format!("  typed {formula}, shown {shown}"));
        }
    }
    for &(formula, _) in EXCEL_ERRORS {
        let (_, shown) = typed(formula);
        if !shown.eq_ignore_ascii_case(formula) {
            renamed.push(format!("  typed {formula}, shown {shown}"));
        }
    }
    assert!(renamed.is_empty(), "RENAMED ({}):\n{}", renamed.len(), renamed.join("\n"));
}
