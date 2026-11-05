//! FILENAME: core/engine/src/typed_name_rendering_tests.rs
//! PURPOSE: A formula keeps the function names the user typed, and an inline
//! LAMBDA call reads back as Excel spells it.
//!
//! NEW-calcula-alias-names (lane formc, 2026-11-05). `AVG`, `CEIL`, `POW` and
//! `FACTORIAL` were hidden parser aliases of AVERAGE, CEILING, POWER and FACT,
//! so a typed `=AVG(1,2)` came back from the formula bar as `=AVERAGE(1,2)`.
//! Excel has none of the four ([LIVE] Excel 16 `=AVG(1,2)`, `=CEIL(1.5)`,
//! `=POW(2,3)`, `=FACTORIAL(3)` are #NAME?, each shown as typed), so they are
//! Calcula's own functions: each keeps its name, computes what its Excel
//! counterpart computes, and -- being a name an Excel workbook may hold as a
//! LAMBDA of its own -- yields to a user definition, as LPAD does.
//!
//! NEW-invoke-rendering. `=LAMBDA(x,x*2)(5)` rendered as
//! `=__INVOKE__(LAMBDA(x,x*2),5)`, the engine's internal marker, in every
//! surface built on `Cell::formula_string` (the formula bar, Find & Replace,
//! the AI's formula context). [LIVE] Excel 16 shows `=LAMBDA(x,x*2)(5)`, 10.

use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

/// The formula TYPED (the cell-entry ladder): its value, the formula bar's
/// text, and the stored (raw) text.
fn typed(formula: &str) -> (EvalResult, String, String) {
    let cell = crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"));
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let grid = Grid::new();
    let value = Evaluator::new(&grid).evaluate(ast);
    (
        value,
        format!("={}", cell.formula_string().expect("a formula cell")),
        format!("={}", cell.formula_string_raw().expect("a formula cell")),
    )
}

#[test]
fn calculas_short_spellings_keep_the_name_typed() {
    for (input, shown, value) in [
        ("=AVG(1,2)", "=AVG(1,2)", 1.5),
        ("=avg(1,2)", "=AVG(1,2)", 1.5),
        ("=CEIL(1.5)", "=CEIL(1.5)", 2.0),
        ("=POW(2,3)", "=POW(2,3)", 8.0),
        ("=FACTORIAL(3)", "=FACTORIAL(3)", 6.0),
        ("=SUM(CEIL({1.2,2.5}))", "=SUM(CEIL({1.2,2.5}))", 5.0),
        ("=AVERAGE(1,2)", "=AVERAGE(1,2)", 1.5),
        ("=POWER(2,3)", "=POWER(2,3)", 8.0),
    ] {
        let (got, bar, raw) = typed(input);
        assert_eq!(bar, shown, "the formula bar shows the name typed");
        assert_eq!(raw, shown, "the cell stores the name typed");
        assert_eq!(got, EvalResult::Number(value), "{input}");
    }
}

#[test]
fn a_user_lambda_of_a_short_spelling_takes_the_call_over() {
    // An Excel workbook's own `POW` (Excel has no POW) must keep its meaning.
    let (got, _, _) = typed("=LET(POW,LAMBDA(x,x+1),POW(2))");
    assert_eq!(got, EvalResult::Number(3.0));
}

/// rev-parse-6 (lane formc): Excel's Insert Function dialog files the
/// functions its 2010 renames superseded under "Compatibility" (Microsoft's
/// "Compatibility functions" reference; the category list is not exposed over
/// COM, so this is the documented list). The fx dialog's category buttons are
/// derived from this catalog (`InsertFunctionDialog.tsx`), so the category is
/// the parser's.
#[test]
fn excels_compatibility_functions_are_in_its_compatibility_category() {
    let catalog = parser::BuiltinFunction::all_catalog_entries();
    let category = |name: &str| {
        catalog
            .iter()
            .find(|m| m.name == name)
            .unwrap_or_else(|| panic!("{name} is in the catalog"))
            .category
    };
    for name in [
        "BETADIST", "BETAINV", "BINOMDIST", "CEILING", "CHIDIST", "CHIINV", "CHITEST", "CONFIDENCE", "COVAR",
        "CRITBINOM", "EXPONDIST", "FDIST", "FINV", "FLOOR", "FORECAST", "FTEST", "GAMMADIST", "GAMMAINV",
        "HYPGEOMDIST", "LOGINV", "LOGNORMDIST", "MODE", "NEGBINOMDIST", "NORMDIST", "NORMINV", "NORMSDIST",
        "NORMSINV", "PERCENTILE", "PERCENTRANK", "POISSON", "QUARTILE", "RANK", "STDEV", "STDEVP", "TDIST",
        "TINV", "TTEST", "VAR", "VARP", "WEIBULL", "ZTEST",
    ] {
        assert_eq!(category(name), "Compatibility", "{name}");
    }
    for (name, home) in [("NORM.S.DIST", "Statistical"), ("STDEV.S", "Statistical"), ("CEILING.MATH", "Math")] {
        assert_eq!(category(name), home, "{name} stays where it was");
    }
}

#[test]
fn an_inline_lambda_call_renders_as_excel_spells_it() {
    for (input, shown, value) in [
        // A parameter keeps its DECLARED spelling ([LIVE] Excel 16, lane formd:
        // `=LAMBDA(x,x*2)(5)` is shown so; this pinned the upper-cased `X`).
        ("=LAMBDA(x,x*2)(5)", "=LAMBDA(x,x*2)(5)", 10.0),
        ("=LAMBDA(x,y,x+y)(1,2)+1", "=LAMBDA(x,y,x+y)(1,2)+1", 4.0),
        ("=SUM(LAMBDA(n,SEQUENCE(n))(3))", "=SUM(LAMBDA(n,SEQUENCE(n))(3))", 6.0),
    ] {
        let (got, bar, raw) = typed(input);
        assert!(!bar.contains("__INVOKE__"), "{input}: the formula bar shows {bar}");
        assert_eq!(bar, shown, "{input}");
        assert_eq!(raw, shown, "{input}: the stored text is the same call");
        assert_eq!(got, EvalResult::Number(value), "{input}");
        // The shown text parses back to the very same tree.
        let again = parser::parse(&shown[1..]).expect("the rendered text parses");
        let (_, rebar, _) = typed(&format!("={}", crate::ast_render::render_formula(&again)));
        assert_eq!(rebar, shown, "{input}: rendering is stable");
    }
}
