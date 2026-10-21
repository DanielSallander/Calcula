//! FILENAME: core/engine/src/locale_text_function_tests.rs
//! PURPOSE: DOLLAR, EURO and FIXED write their text in the evaluator's locale,
//!          and DATEVALUE / TIMEVALUE read the evaluator's locale date order
//!          first (P2 S1, app locale everywhere).
//!
//! TWO HALVES, ONE RULE. With the evaluator's DEFAULT (invariant, en-US)
//! locale every answer is byte-identical to what these builtins produced when
//! they hard-coded en-US -- the first block pins that. Under another locale the
//! produced text follows that locale's table in `locale.rs` exactly as written
//! (de-DE's euro sign is BEFORE the number there, "€ ", and the table is not
//! changed here), and a typed-looking date is read in that locale's order.

use crate::cell::CellError;
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn eval_in(locale: Option<&str>, formula: &str) -> EvalResult {
    let grid = Grid::new();
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("`{}` does not parse: {}", formula, e));
    let mut evaluator = Evaluator::new(&grid);
    if let Some(id) = locale {
        evaluator.set_locale(LocaleSettings::from_locale_id(id));
    }
    evaluator.evaluate(&ast)
}

fn text_in(locale: Option<&str>, formula: &str) -> String {
    match eval_in(locale, formula) {
        EvalResult::Text(t) => t,
        other => panic!("`{}` in {:?} gave {:?}, expected text", formula, locale, other),
    }
}

fn number_in(locale: Option<&str>, formula: &str) -> f64 {
    match eval_in(locale, formula) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` in {:?} gave {:?}, expected a number", formula, locale, other),
    }
}

// ===========================================================================
// THE DEFAULT LOCALE IS UNCHANGED (the old en-US spelling, byte for byte)
// ===========================================================================

#[test]
fn default_locale_dollar_euro_fixed_are_the_old_en_us_text() {
    assert_eq!(text_in(None, "=DOLLAR(1234.5)"), "$1,234.50");
    assert_eq!(text_in(None, "=DOLLAR(-1234.567,2)"), "($1,234.57)");
    assert_eq!(text_in(None, "=DOLLAR(1234567.891,0)"), "$1,234,568");
    assert_eq!(text_in(None, "=DOLLAR(1250,-2)"), "$1,300");
    assert_eq!(text_in(None, "=DOLLAR(0.5)"), "$0.50");
    assert_eq!(text_in(None, "=DOLLAR(-0.001)"), "$0.00");
    assert_eq!(text_in(None, "=EURO(1234.5)"), "\u{20AC}1,234.50");
    assert_eq!(text_in(None, "=EURO(-5)"), "(\u{20AC}5.00)");
    assert_eq!(text_in(None, "=FIXED(1234.567)"), "1,234.57");
    assert_eq!(text_in(None, "=FIXED(1234.567,1,TRUE)"), "1234.6");
    assert_eq!(text_in(None, "=FIXED(-1234567.5,0)"), "-1,234,568");
    assert_eq!(text_in(None, "=FIXED(999.999,2)"), "1,000.00");
    assert_eq!(text_in(None, "=FIXED(12,3)"), "12.000");
}

#[test]
fn default_locale_datevalue_and_timevalue_keep_working() {
    assert_eq!(number_in(None, "=DATEVALUE(\"2024-01-15\")"), 45306.0);
    assert_eq!(number_in(None, "=DATEVALUE(\"01/15/2024\")"), 45306.0);
    assert_eq!(number_in(None, "=DATEVALUE(\"1/15/2024\")"), 45306.0);
    assert_eq!(number_in(None, "=TIMEVALUE(\"12:00\")"), 0.5);
    assert_eq!(number_in(None, "=TIMEVALUE(\"14:30:00\")"), (14.5 * 3600.0) / 86400.0);
    assert_eq!(number_in(None, "=TIMEVALUE(\"2:30 PM\")"), (14.5 * 3600.0) / 86400.0);
    // A time-only text is not a date.
    assert_eq!(eval_in(None, "=DATEVALUE(\"12:00\")"), EvalResult::Error(CellError::Value));
    assert_eq!(eval_in(None, "=DATEVALUE(\"not a date\")"), EvalResult::Error(CellError::Value));
    assert_eq!(eval_in(None, "=TIMEVALUE(\"later\")"), EvalResult::Error(CellError::Value));
}

// ===========================================================================
// DOLLAR / EURO / FIXED IN THE LOCALE
// ===========================================================================

#[test]
fn dollar_uses_the_locale_symbol_position_and_separators() {
    // de-DE: the table says "€ " BEFORE the number.
    assert_eq!(text_in(Some("de-DE"), "=DOLLAR(1234.5)"), "\u{20AC} 1.234,50");
    // fr-FR: NBSP grouping, " €" AFTER the number.
    assert_eq!(text_in(Some("fr-FR"), "=DOLLAR(1234.5)"), "1\u{00A0}234,50 \u{20AC}");
    // sv-SE: " kr" after, NBSP grouping.
    assert_eq!(text_in(Some("sv-SE"), "=DOLLAR(1234.5)"), "1\u{00A0}234,50 kr");
    // en-GB: pound before, en-US separators.
    assert_eq!(text_in(Some("en-GB"), "=DOLLAR(1234.5)"), "\u{00A3}1,234.50");
    // de-CH: apostrophe grouping, "." decimal.
    assert_eq!(text_in(Some("de-CH"), "=DOLLAR(1234567.5)"), "CHF 1'234'567.50");
}

#[test]
fn a_negative_is_bracketed_only_where_the_region_brackets_it() {
    assert_eq!(text_in(Some("en-US"), "=DOLLAR(-12.5)"), "($12.50)");
    assert_eq!(text_in(Some("de-DE"), "=DOLLAR(-12.5)"), "-\u{20AC} 12,50");
    assert_eq!(text_in(Some("sv-SE"), "=DOLLAR(-1234.5)"), "-1\u{00A0}234,50 kr");
    assert_eq!(text_in(Some("en-GB"), "=DOLLAR(-1)"), "-\u{00A3}1.00");
}

#[test]
fn euro_keeps_its_sign_and_takes_the_locale_separators() {
    assert_eq!(text_in(Some("de-DE"), "=EURO(1234.5)"), "\u{20AC}1.234,50");
    assert_eq!(text_in(Some("sv-SE"), "=EURO(1234.5)"), "\u{20AC}1\u{00A0}234,50");
}

#[test]
fn fixed_uses_the_locale_separators() {
    assert_eq!(text_in(Some("sv-SE"), "=FIXED(1234.567,2)"), "1\u{00A0}234,57");
    assert_eq!(text_in(Some("sv-SE"), "=FIXED(1234.567,2,TRUE)"), "1234,57");
    assert_eq!(text_in(Some("de-DE"), "=FIXED(1234567.891)"), "1.234.567,89");
    assert_eq!(text_in(Some("de-DE"), "=FIXED(1234567.891,2,TRUE)"), "1234567,89");
    assert_eq!(text_in(Some("de-DE"), "=FIXED(-1234.5,0)"), "-1.235");
    assert_eq!(text_in(Some("de-CH"), "=FIXED(1234.5,1)"), "1'234.5");
}

// ===========================================================================
// DATEVALUE / TIMEVALUE READ THE LOCALE ORDER FIRST
// ===========================================================================

#[test]
fn datevalue_reads_the_locale_date_order() {
    assert_eq!(number_in(Some("en-GB"), "=DATEVALUE(\"15/01/2024\")"), 45306.0);
    assert_eq!(number_in(Some("de-DE"), "=DATEVALUE(\"15.01.2024\")"), 45306.0);
    // The time part is dropped, as Excel does.
    assert_eq!(number_in(Some("de-DE"), "=DATEVALUE(\"15.01.2024 13:00\")"), 45306.0);
    // en-US fallback intact.
    assert_eq!(number_in(Some("en-US"), "=DATEVALUE(\"01/15/2024\")"), 45306.0);
    // The locale WINS over the US fallback: en-GB 01/02/2024 is 1 February.
    assert_eq!(number_in(Some("en-GB"), "=DATEVALUE(\"01/02/2024\")"), 45323.0);
    // The locale's own month names.
    assert_eq!(number_in(Some("sv-SE"), "=DATEVALUE(\"15 januari 2024\")"), 45306.0);
    assert_eq!(number_in(Some("de-DE"), "=DATEVALUE(\"15. Januar 2024\")"), 45306.0);
}

#[test]
fn iso_dates_work_in_every_locale() {
    for (id, _) in LocaleSettings::supported_locales() {
        assert_eq!(number_in(Some(&id), "=DATEVALUE(\"2024-01-15\")"), 45306.0, "{id}");
        assert_eq!(number_in(Some(&id), "=TIMEVALUE(\"2024-01-15 06:00\")"), 0.25, "{id}");
    }
}

#[test]
fn timevalue_reads_the_locale_and_a_date_only_text_is_midnight() {
    assert_eq!(number_in(Some("de-DE"), "=TIMEVALUE(\"15.01.2024 12:00\")"), 0.5);
    assert_eq!(number_in(Some("de-DE"), "=TIMEVALUE(\"15.01.2024\")"), 0.0);
    assert_eq!(number_in(Some("sv-SE"), "=TIMEVALUE(\"18:00\")"), 0.75);
    // A locale with no AM/PM: the lax fallback still reads it.
    assert_eq!(number_in(Some("sv-SE"), "=TIMEVALUE(\"6:00 PM\")"), 0.75);
}

#[test]
fn a_text_the_locale_does_not_read_falls_back_or_errors() {
    // 01/15/2024 is no day-month-year date (month 15), so de-DE's own reading
    // refuses it and the US month-first fallback still reads it.
    assert_eq!(number_in(Some("de-DE"), "=DATEVALUE(\"01/15/2024\")"), 45306.0);
    assert_eq!(eval_in(Some("de-DE"), "=DATEVALUE(\"32.01.2024\")"), EvalResult::Error(CellError::Value));
    assert_eq!(eval_in(Some("sv-SE"), "=DATEVALUE(\"12:00\")"), EvalResult::Error(CellError::Value));
}
