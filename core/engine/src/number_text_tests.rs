//! FILENAME: core/engine/src/number_text_tests.rs
//! PURPOSE: The one number PARSER and the one number FORMATTER — the text->
//!          number coercion under every arithmetic operator, the number->text
//!          conversion under `&` and every text function, and Excel's
//!          cancellation correction on a formula's final add or subtract.
//!
//! ## What was silently wrong without these
//!
//! `EvalResult::as_number` reached for Rust's `f64::from_str`, which knows one
//! dialect and it is not Excel's. Six separately-filed defects were that one
//! line and its formatting twin:
//!
//!   * `="5%"+0`, `="$5"+0`, `="1 000"+0` and `="2020-01-01"+1` were `#VALUE!`;
//!   * `="1,5"+0` was `#VALUE!` and `="1.5"+0` was 1.5 — on the sv-SE build
//!     this ships to, i.e. exactly backwards for its own users;
//!   * `="inf"+0` produced a NON-FINITE number in a cell, which `ISNUMBER`
//!     then called TRUE;
//!   * `="Total: "&1,5` read "Total: 1.5" in sv-SE, `="x"&(0.1+0.2)` read
//!     "x0.30000000000000004" where Excel reads "x0.3", and `="x"&1e300` built
//!     a THREE-HUNDRED-AND-ONE character digit string;
//!   * `=1.333+1.225-1.333-1.225` answered -2.220446049250313E-16 where Excel
//!     answers 0, so every `=…=0` a user writes over such a formula was FALSE.
//!
//! ## The three things that would be silently wrong if these tests were weak
//!
//!   * **A parser that is merely MORE PERMISSIVE.** "Strip the group separator
//!     and parse what is left" makes every case above pass and turns a
//!     European's `"1,5"` into FIFTEEN in an en-US workbook. Every acceptance
//!     here is therefore paired with a refusal that shares its shape.
//!   * **A locale that is consulted in only one direction.** The formatter
//!     writing `1,5` while the parser only reads `1.5` is worse than neither
//!     knowing the locale, because a value stops surviving its own round trip.
//!     `a_formatted_number_parses_back_in_both_dialects` asserts the pair.
//!   * **A snap-to-zero that fires on every small number.** An absolute epsilon
//!     would pass the documented example and destroy `1e-300`. The threshold is
//!     relative, and `1e-300` is a standing control.

use crate::cell::Cell;
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;
use crate::number_text::{format, parse, NumberTextLocale, ParsePolicy};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn us() -> NumberTextLocale {
    NumberTextLocale::INVARIANT
}

/// sv-SE: decimal `,` and a NON-BREAKING space for groups. Built from
/// `LocaleSettings` rather than hand-written, so a change to the shipping
/// locale's own table reaches these tests instead of being shadowed by them.
fn se() -> NumberTextLocale {
    NumberTextLocale::of(&LocaleSettings::from_locale_id("sv-SE"))
}

/// Coercion policy: what an operand of `+` gets.
fn coerce(text: &str, locale: NumberTextLocale) -> Option<f64> {
    parse(text, locale, ParsePolicy::COERCION)
}

/// Entry policy: what the host's typed-entry ladder gets.
fn entry(text: &str, locale: NumberTextLocale) -> Option<f64> {
    parse(text, locale, ParsePolicy::ENTRY)
}

/// Evaluate a whole formula through the real evaluator in `locale`, so the
/// tests exercise the AMBIENT INSTALL as well as the parser — a parser that is
/// perfect and never reached is the defect this file also has to catch.
fn eval_in(formula: &str, locale_id: &str) -> EvalResult {
    let grid = Grid::new();
    let ast = parser::parse(formula).expect("formula parses");
    let mut evaluator = Evaluator::new(&grid);
    evaluator.set_locale(LocaleSettings::from_locale_id(locale_id));
    evaluator.evaluate(&ast)
}

fn eval(formula: &str) -> EvalResult {
    eval_in(formula, "en-US")
}

fn number(formula: &str) -> f64 {
    match eval(formula) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` gave {:?}, expected a number", formula, other),
    }
}

fn text_of(formula: &str) -> String {
    match eval(formula) {
        EvalResult::Text(s) => s,
        other => panic!("`{}` gave {:?}, expected text", formula, other),
    }
}

/// The criteria tests need REAL CELLS, because the whole question is how a
/// stored value and a typed criteria are read against each other.
fn eval_grid_in(grid: &Grid, formula: &str, locale_id: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    let mut evaluator = Evaluator::new(grid);
    evaluator.set_locale(LocaleSettings::from_locale_id(locale_id));
    evaluator.evaluate(&ast)
}

fn number_grid_in(grid: &Grid, formula: &str, locale_id: &str) -> f64 {
    match eval_grid_in(grid, formula, locale_id) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` in {} gave {:?}, expected a number", formula, locale_id, other),
    }
}

// ===========================================================================
// THE PARSER — the six measured coercion defects
// ===========================================================================

#[test]
fn a_percentage_written_as_text_is_a_number() {
    // MEASURED BEFORE THE FIX: #VALUE!. Rust's parser has no percent sign.
    assert_eq!(number("=\"5%\"+0"), 0.05);
    assert_eq!(coerce("50%", us()), Some(0.5));
    // Excel divides once per sign, so a doubled percent is a per-mille-squared
    // and not a typo to be forgiven: "5%%" is 0.0005, not 0.05.
    assert_eq!(coerce("5%%", us()), Some(0.0005));
    // A LEADING percent means the same thing as a trailing one.
    assert_eq!(coerce("%5", us()), Some(0.05));
    // CONTROL: the sign has to be attached to a number. A bare "%" is text.
    assert_eq!(coerce("%", us()), None);

    // THE SWEDISH SPELLING, `"5 %"` with a space, and it is the one input that
    // proves the group-separator LOOKAHEAD does anything: sv-SE's group
    // separator IS a space, so without "only when a digit follows" that space
    // opens a group which never gets its three digits and the whole entry
    // becomes text. The sabotage run found this untested and it was added for
    // that reason.
    assert_eq!(coerce("5 %", se()), Some(0.05));
    assert_eq!(coerce("1 000 %", se()), Some(10.0));
}

#[test]
fn a_currency_amount_written_as_text_is_a_number() {
    // MEASURED BEFORE THE FIX: #VALUE!.
    assert_eq!(number("=\"$5\"+0"), 5.0);
    assert_eq!(coerce("$1,234.50", us()), Some(1234.5));
    // Sign on either side of the symbol, as in Excel.
    assert_eq!(coerce("-$5", us()), Some(-5.0));
    assert_eq!(coerce("$-5", us()), Some(-5.0));
    // A LETTER-SPELLED currency symbol is NOT stripped — sv-SE's is " kr", and
    // stripping letters would make "5 kr" a number while "5 kg" stays text, a
    // distinction no user could predict. Excel refuses both.
    assert_eq!(coerce("5 kr", se()), None);
    // CONTROL: the ENTRY policy refuses the currency sign, because the ladder
    // has no currency rung to carry the symbol onto the cell and a bare `5`
    // would make the `$` the user typed vanish.
    assert_eq!(entry("$5", us()), None);
    assert_eq!(entry("5", us()), Some(5.0));
}

#[test]
fn an_iso_date_written_as_text_is_its_serial() {
    // MEASURED BEFORE THE FIX: #VALUE!. `="2020-01-01"+1` is the idiom this is
    // for, and the answer is the NEXT day's serial.
    assert_eq!(number("=\"2020-01-01\"+1"), 43832.0);
    assert_eq!(coerce("2020-01-01", us()), Some(43831.0));

    // THE GUARDS, each one a wrong DATE the unguarded reading would produce —
    // the worst class of failure here, because nothing on the cell would say
    // the value had been read as a date at all.
    //
    // A part number is not the 3rd of February in the year 1:
    assert_eq!(coerce("1-2-3", us()), None);
    // A day that does not exist is not the 2nd of March:
    assert_eq!(coerce("2020-02-31", us()), None);
    // ...while the same month's real last day is:
    assert_eq!(coerce("2020-02-29", us()), Some(43890.0));
    // Outside the serial epoch:
    assert_eq!(coerce("1899-12-31", us()), None);
    // A year is FOUR DIGITS, not "a number that happens to be in range". This
    // is the one input the length guard catches that the range guard does not,
    // and it is here because the sabotage run proved the length guard was
    // otherwise untested: every other malformed year is already out of range.
    assert_eq!(coerce("02020-01-01", us()), None);
    // AMBIGUOUS ORDER IS REFUSED, not guessed. "6/1/2020" is June 1st in en-US
    // and is not how sv-SE writes a date at all; the locale-aware ladder for
    // typed entry lives in the host, and this parser does not duplicate it.
    assert_eq!(coerce("6/1/2020", us()), None);

    // CONTROL: the ENTRY policy must NOT see dates, or the typed-entry ladder's
    // number rung would swallow "2020-01-01" and store a bare 43831 with no
    // date format — the user types a date and the cell shows a five-digit
    // number.
    assert_eq!(entry("2020-01-01", us()), None);
}

#[test]
fn a_grouped_number_written_as_text_is_a_number() {
    // MEASURED BEFORE THE FIX: #VALUE! for every one of these.
    assert_eq!(coerce("1,000", us()), Some(1000.0));
    assert_eq!(coerce("1,234,567.5", us()), Some(1234567.5));
    // sv-SE groups with a NON-BREAKING space, and a keyboard makes an ordinary
    // one. Refusing the character the user actually types would make the
    // separator read off their own regional settings useless to them.
    assert_eq!(coerce("1 000", se()), Some(1000.0));
    assert_eq!(coerce("1\u{00A0}000,5", se()), Some(1000.5));
}

#[test]
fn a_mis_grouped_number_is_text_and_not_a_number_ten_times_too_big() {
    // THE CONTROL THAT MAKES THE TEST ABOVE MEAN SOMETHING, and a defect that
    // was live in the host's entry parser until this landed: "strip the group
    // separator and parse what is left" answers `"1,5"` with FIFTEEN in an
    // en-US workbook — a European's one-and-a-half, in a cell, with no error on
    // it. Grouping is VALIDATED, so this is text.
    assert_eq!(coerce("1,5", us()), None);
    assert_eq!(coerce("1,23", us()), None);
    assert_eq!(entry("1,5", us()), None);
    // A group that is too LONG is equally not a group.
    assert_eq!(coerce("1,2345", us()), None);
    assert_eq!(coerce("12345,678,9", us()), None);
    // ...and a trailing separator ends nothing.
    assert_eq!(coerce("1,", us()), None);
    // The de-DE spelling of a date survives for the same reason: '.' groups
    // thousands there, so stripping dots turned "1.6.2020" into 162020.
    let de = NumberTextLocale::of(&LocaleSettings::from_locale_id("de-DE"));
    assert_eq!(entry("1.6.2020", de), None);
}

#[test]
fn the_decimal_separator_is_the_locales_and_the_foreign_one_is_text() {
    // MEASURED BEFORE THE FIX, and the pair is the whole point: on the sv-SE
    // build `="1,5"+0` was #VALUE! and `="1.5"+0` was 1.5. Both answers were
    // backwards.
    assert_eq!(coerce("1,5", se()), Some(1.5));
    assert_eq!(coerce("1.5", se()), None);
    // ...and the en-US pair is the mirror image, so a fix that simply swapped
    // the hard-coded characters cannot satisfy both halves.
    assert_eq!(coerce("1.5", us()), Some(1.5));
    assert_eq!(coerce("1,5", us()), None);

    // THROUGH THE REAL EVALUATOR, because a parser that is right and never
    // reached is the other half of this defect. The ambient dialect is
    // installed by `Evaluator::evaluate` from the workbook's locale.
    assert_eq!(number_in("=\"1,5\"+0", "sv-SE"), 1.5);
    assert!(matches!(eval_in("=\"1.5\"+0", "sv-SE"), EvalResult::Error(_)));
}

fn number_in(formula: &str, locale_id: &str) -> f64 {
    match eval_in(formula, locale_id) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` in {} gave {:?}", formula, locale_id, other),
    }
}

#[test]
fn no_spelling_of_infinity_or_nan_survives_into_the_grid() {
    // MEASURED BEFORE THE FIX: `="inf"+0` produced a non-finite NUMBER that
    // `ISNUMBER` called TRUE, and `=("i"&"nf")+1` then tripped the overflow
    // guard as #NUM! — the same text, two different wrong answers.
    //
    // These pass by CONSTRUCTION rather than by blacklist: the string handed to
    // `f64::from_str` is BUILT from ASCII digits, at most one '.', at most one
    // sign and a validated exponent, so no alphabetic spelling can reach it. A
    // blacklist would have missed at least one of the twelve below.
    for spelling in [
        "inf", "INF", "Inf", "+inf", "-inf", "infinity", "Infinity", "-Infinity", "nan", "NaN",
        "NAN", "-nan",
    ] {
        assert_eq!(coerce(spelling, us()), None, "{:?} must be text", spelling);
        assert_eq!(entry(spelling, us()), None, "{:?} must be text", spelling);
    }
    assert!(matches!(eval("=\"inf\"+0"), EvalResult::Error(_)));
    assert!(matches!(eval("=(\"i\"&\"nf\")+1"), EvalResult::Error(_)));

    // OVERFLOW IS NOT A NUMBER EITHER. "1e400" is finite-looking text that IEEE
    // rounds to +inf; the finiteness check after parsing is what catches it,
    // and the percent path — which is where the host's own parser leaked an
    // `inf` into a cell — goes through the same check.
    assert_eq!(coerce("1e400", us()), None);
    assert_eq!(coerce("inf%", us()), None);
    assert_eq!(entry("inf%", us()), None);
}

#[test]
fn the_ordinary_spellings_still_parse() {
    // The acceptances that must not be lost to all the refusing above.
    assert_eq!(coerce("  12  ", us()), Some(12.0));
    assert_eq!(coerce("-3", us()), Some(-3.0));
    assert_eq!(coerce("+3", us()), Some(3.0));
    assert_eq!(coerce("1e3", us()), Some(1000.0));
    assert_eq!(coerce("1.5E+3", us()), Some(1500.0));
    assert_eq!(coerce("1E-3", us()), Some(0.001));
    assert_eq!(coerce(".5", us()), Some(0.5));
    assert_eq!(coerce("5.", us()), Some(5.0));
    // ...and the refusals that share their shape.
    assert_eq!(coerce("", us()), None);
    assert_eq!(coerce("   ", us()), None);
    assert_eq!(coerce("-", us()), None);
    assert_eq!(coerce(".", us()), None);
    assert_eq!(coerce("--5", us()), None);
    assert_eq!(coerce("1e", us()), None);
    assert_eq!(coerce("5x", us()), None);
    assert_eq!(coerce("0x1f", us()), None);
    // Rust's own numeric literal syntax is not Excel's.
    assert_eq!(coerce("1_000", us()), None);
}

// ===========================================================================
// THE FORMATTER
// ===========================================================================

#[test]
fn a_number_becomes_text_at_excels_fifteen_significant_digits() {
    // MEASURED BEFORE THE FIX: "x0.30000000000000004" and
    // "x0.3333333333333333" — Rust's shortest-round-trip Display, which is 16-17
    // significant digits where Excel keeps 15.
    assert_eq!(text_of("=\"x\"&(0.1+0.2)"), "x0.3");
    assert_eq!(text_of("=\"x\"&(1/3)"), "x0.333333333333333");
    assert_eq!(format(2f64.sqrt(), us()), "1.4142135623731");
    // CONTROL: fifteen digits are KEPT, not five. A formatter that simply
    // rounded hard would pass the two assertions above and destroy this one.
    assert_eq!(format(123456789.012345, us()), "123456789.012345");
}

#[test]
fn a_very_large_or_very_small_number_becomes_scientific_text() {
    // MEASURED BEFORE THE FIX: `="x"&1e300` built a 301-character string of
    // digits, because Rust's Display never uses scientific notation.
    assert_eq!(text_of("=\"x\"&1e300"), "x1E+300");
    assert_eq!(format(1.23456789012345678e17, us()), "1.23456789012346E+17");
    assert_eq!(format(1.23e-16, us()), "1.23E-16");

    // THE BOUNDARIES, paired so a threshold moved by one cannot pass. The
    // switch is at 1e15 and 1e-4, the same pair `number_format::format_general`
    // uses for the CELL DISPLAY path, so a value drawn in scientific notation
    // in its cell also concatenates that way.
    assert_eq!(format(999999999999999.0, us()), "999999999999999");
    assert_eq!(format(1e15, us()), "1E+15");
    assert_eq!(format(0.0001, us()), "0.0001");
    assert_eq!(format(0.00001, us()), "1E-05");
}

#[test]
fn number_to_text_uses_the_workbooks_decimal_separator() {
    // MEASURED BEFORE THE FIX: in sv-SE, `="Total: "&1,5` gave "Total: 1.5".
    assert_eq!(format(1.5, se()), "1,5");
    assert_eq!(format(-0.25, se()), "-0,25");
    // The mantissa's point is a decimal point too.
    assert_eq!(format(1.23e-16, se()), "1,23E-16");
    // CONTROL: en-US is unchanged, so a fix that simply swapped the character
    // cannot satisfy both.
    assert_eq!(format(1.5, us()), "1.5");

    // Through the real evaluator, i.e. the ambient install as well.
    match eval_in("=\"Total: \"&1.5", "sv-SE") {
        EvalResult::Text(s) => assert_eq!(s, "Total: 1,5"),
        other => panic!("expected text, got {:?}", other),
    }
    // NO GROUP SEPARATOR is inserted, in either dialect — Excel's `&` does not
    // group, and grouping here would make `=VALUE(A1&"")` depend on the locale
    // in a second, subtler way.
    assert_eq!(format(1234567.0, us()), "1234567");
    assert_eq!(format(1234567.0, se()), "1234567");
}

#[test]
fn zero_and_negative_zero_and_whole_numbers_read_the_way_excel_writes_them() {
    assert_eq!(format(0.0, us()), "0");
    // A stored NEGATIVE zero must not concatenate as "-0".
    assert_eq!(format(-0.0, us()), "0");
    assert_eq!(format(42.0, us()), "42");
    assert_eq!(format(-100.0, us()), "-100");
    assert_eq!(format(1.10, us()), "1.1");
}

#[test]
fn a_formatted_number_parses_back_in_both_dialects() {
    // THE CONTRACT BETWEEN THE TWO HALVES, and the reason they live in one
    // module: whatever the formatter emits, the parser must accept, in the SAME
    // locale. A formatter that learned the Swedish comma while the parser did
    // not would make a value stop surviving its own round trip.
    //
    // The equality is to fifteen significant digits, not to the bit: Excel
    // keeps fifteen, and this pair is Excel's precision, not IEEE's.
    let values = [
        0.0, 1.0, -1.0, 1.5, -0.25, 0.1, 1.0 / 3.0, 1234567.0, 999999999999999.0, 1e15, 1e300,
        1e-300, 0.0001, 0.00001, 1.23e-16, 43831.0, -1234567.891, 2f64.sqrt(),
    ];
    for dialect in [us(), se()] {
        for value in values {
            let written = format(value, dialect);
            let read = parse(&written, dialect, ParsePolicy::COERCION)
                .unwrap_or_else(|| panic!("{:?} wrote {:?} and could not read it back", value, written));
            // Half a unit in the FIFTEENTH significant digit is up to 5e-15
            // in relative terms (worst case, a mantissa just above 1), so the
            // tolerance is 1e-14 and not 1e-15. Measured, not guessed: at
            // 1e-15 this assertion reds on sqrt(2), whose 15-digit form is
            // 1.41421356237310 against an f64 of 1.4142135623730951.
            let tolerance = value.abs() * 1e-14;
            assert!(
                (read - value).abs() <= tolerance,
                "{:?} wrote {:?} and read back {:?}",
                value,
                written,
                read
            );
        }
    }
}

#[test]
fn the_cell_display_path_is_a_different_path_but_agrees_on_the_spelling() {
    // `number_format::format_general` renders a STORED value through the cell's
    // number format and is reached from the renderer; this module renders a
    // value into a STRING inside a formula. They remain two paths, and confusing
    // them is how a change meant for concatenation ends up redrawing the grid —
    // so the display path is still pinned here from the outside.
    //
    // WHAT CHANGED, AND IT IS A FIX RATHER THAN A DRIFT. This test used to
    // assert that the display path wrote `"1e300"` while the value path wrote
    // `"1E+300"`, under the name `..._and_is_untouched`. Pinning that gap
    // pinned a DEFECT: one product spelled the same number two ways, so a user
    // who saw "1e300" in a cell and "1E+300" from `=A1&""` had no way to know
    // which one another tool would accept — and Excel accepts only the second.
    // Both now write Excel's spelling.
    let locale = LocaleSettings::invariant();
    assert_eq!(
        crate::number_format::format_number(1e300, &crate::style::NumberFormat::General, &locale),
        "1E+300"
    );
    assert_eq!(format(1e300, us()), "1E+300");

    // THE PATHS ARE STILL TWO, and this is what still separates them: PRECISION.
    // The display path formats to six significant digits (`{:.5e}`), the value
    // path to Excel's fifteen. A "tidy-up" that routed one through the other
    // would change what a cell shows or what a concatenation produces, so the
    // difference is asserted rather than left to be discovered.
    let long = 1.234_567_890_123_45e-7_f64;
    assert_eq!(
        crate::number_format::format_number(long, &crate::style::NumberFormat::General, &locale),
        "1.23457E-07"
    );
    assert_eq!(format(long, us()), "1.23456789012345E-07");
}

// ===========================================================================
// SNAP TO ZERO
// ===========================================================================

#[test]
fn the_final_subtraction_of_cancelling_operands_is_exactly_zero() {
    // MICROSOFT'S OWN EXAMPLE (KB 78113). MEASURED BEFORE THE FIX:
    // -2.220446049250313e-16.
    assert_eq!(number("=1.333+1.225-1.333-1.225"), 0.0);
    assert_eq!(number("=0.1+0.2-0.3"), 0.0);
    // A second, independent cancellation, so the first is not a coincidence of
    // one arithmetic accident.
    assert_eq!(number("=1.1+2.2-3.3"), 0.0);
    // The value is EXACTLY zero and POSITIVE zero — `assert_eq!(x, 0.0)` above
    // is already false for the -2.2e-16 that used to come back, and this rules
    // out a "-0.0" that would print with a minus sign in `="x"&…`.
    match eval("=1.333+1.225-1.333-1.225") {
        EvalResult::Number(n) => assert!(
            n == 0.0 && !n.is_sign_negative(),
            "expected a positive exact zero, got {:?}",
            n
        ),
        other => panic!("expected a number, got {:?}", other),
    }
}

#[test]
fn a_small_number_that_is_not_a_cancellation_survives() {
    // THE CONTROL, and it is the assertion that decides whether this feature is
    // a fix or a data-loss bug. An ABSOLUTE epsilon would pass every assertion
    // in the test above and silently zero every legitimately tiny value in the
    // workbook. The threshold is RELATIVE to the larger operand: 1e-300 is
    // vanishing in absolute terms and is exactly its own size in relative ones.
    assert_eq!(number("=1e-300-0"), 1e-300);
    assert_eq!(number("=0.0000001+0"), 0.0000001);
    // A real difference of two close numbers is still a real difference.
    assert_eq!(number("=1.0000001-1"), 1.0000001 - 1.0);
}

#[test]
fn the_correction_applies_to_the_final_operation_and_to_nothing_else() {
    // EXCEL'S RULE IS ABOUT THE LAST OPERATION, and this is the half that is
    // easy to over-apply. Multiplying the cancelling expression by one makes
    // the multiply the final operation, and the residue comes back — in Excel
    // too. Asserting only "it is zero" everywhere would hide an implementation
    // that snapped every intermediate, which would change results all over the
    // language.
    assert!(number("=(1.333+1.225-1.333-1.225)*1") != 0.0);
    // The famous consequence: a COMPARISON is the final operation here, so the
    // subtraction inside it is not corrected and the answer is FALSE — which is
    // exactly what Excel answers, and why `=IF(A-B=0,…)` still surprises people.
    assert_eq!(eval("=(1.333+1.225-1.333-1.225)=0"), EvalResult::Boolean(false));
    // A cancelling add/subtract nested in a function argument keeps its residue.
    assert!(number("=SUM(1.333+1.225-1.333-1.225)") != 0.0);
}

// ===========================================================================
// TIME OF DAY — the other half of a date-time serial
// ===========================================================================

/// MEASURED BEFORE THE FIX: `="12:00"+0` was `#VALUE!` while
/// `="2020-01-01"+0` was 43831. A serial is ONE number whose integer part is
/// the date and whose fraction IS the time, so understanding only the integer
/// half made `="2020-01-01 12:00"+0` — a perfectly ordinary timestamp pasted
/// out of a log — an error rather than a moment.
#[test]
fn a_time_of_day_written_as_text_is_a_fraction_of_a_day() {
    assert_eq!(number("=\"12:00\"+0"), 0.5);
    assert_eq!(number("=\"12:00:00\"+0"), 0.5);
    assert_eq!(coerce("00:00", us()), Some(0.0));
    assert_eq!(coerce("06:00", us()), Some(0.25));
    assert_eq!(coerce("18:30", us()), Some((18.5 * 3600.0) / 86400.0));
    // The meridiem spelling, both ways round. "12:00 AM" is MIDNIGHT and
    // "12:00 PM" is noon — the one pair a naive `+12` gets backwards.
    assert_eq!(coerce("2:30 PM", us()), Some((14.5 * 3600.0) / 86400.0));
    assert_eq!(coerce("12:00 AM", us()), Some(0.0));
    assert_eq!(coerce("12:00 PM", us()), Some(0.5));
    // ELAPSED time past midnight, which Excel accepts and which is the reason
    // hours are not bounded at 23.
    assert_eq!(coerce("25:00", us()), Some(25.0 / 24.0));
    // DATE AND TIME TOGETHER is the SUM, not a choice between the two.
    assert_eq!(number("=\"2020-01-01 12:00\"+0"), 43831.5);
    assert_eq!(coerce("2020-01-01 06:00:00", us()), Some(43831.25));
}

/// The guards, and the first is the one that would have been catastrophic.
///
/// `date_serial::parse_time_string` is deliberately lax because its own callers
/// have already decided the text is a time: handed a bare `"12"` it splits into
/// ONE part and answers 0.5. Calling it unguarded from the coercion path would
/// have made `="12"+0` answer half past midnight instead of twelve — a wrong
/// NUMBER, in every workbook, for the most ordinary input there is.
#[test]
fn a_number_is_not_a_time_and_a_bad_time_is_not_a_number() {
    // THE CONTROL THAT MATTERS MOST. Twelve is twelve.
    assert_eq!(coerce("12", us()), Some(12.0));
    assert_eq!(number("=\"12\"+0"), 12.0);
    assert_eq!(coerce("1230", us()), Some(1230.0));
    // Minutes and seconds are base 60, as in Excel — `TIMEVALUE("12:70")` is
    // `#VALUE!` there and typing `12:70` leaves a text cell.
    assert_eq!(coerce("12:70", us()), None);
    assert_eq!(coerce("12:00:70", us()), None);
    // A meridiem pins the hour to a 12-hour clock: "25:00" is elapsed time,
    // "25:00 PM" is nothing at all.
    assert_eq!(coerce("25:00 PM", us()), None);
    assert_eq!(coerce("0:00 AM", us()), None);
    // Non-digits, empty components, and too many components.
    assert_eq!(coerce("a:b", us()), None);
    assert_eq!(coerce("12:", us()), None);
    assert_eq!(coerce(":30", us()), None);
    assert_eq!(coerce("1:2:3:4", us()), None);
    // A DATE WITH RUBBISH AFTER IT is not the date. The combined branch splits
    // on whitespace and both halves must parse.
    assert_eq!(coerce("2020-01-01 lunchtime", us()), None);

    // THE TYPED-ENTRY LADDER IS UNCHANGED, for the same reason it refuses
    // dates: it has its own, richer, locale-aware time rung and a time
    // swallowed here would be stored as a bare fraction with no time format —
    // the user types `12:00` and the cell shows `0.5`.
    assert_eq!(entry("12:00", us()), None);
    assert_eq!(entry("2020-01-01 12:00", us()), None);
}

// ===========================================================================
// VALUE() AND NUMBERVALUE() — the same parser, or a different answer
// ===========================================================================

/// `=VALUE(A1)` and `=A1+0` are the two standard spellings of one question.
///
/// MEASURED BEFORE THE FIX, and each line was a live disagreement inside one
/// workbook: `=VALUE("5%")` was `#VALUE!` while `="5%"+0` was 0.05;
/// `=VALUE("$5")` was `#VALUE!` while `="$5"+0` was 5. A user who reaches for
/// the function documented to do the job got the error, and the one who used
/// the idiom got the answer.
#[test]
fn value_and_plus_zero_answer_the_same_question() {
    for spelling in ["5%", "$5", "2020-01-01", "12:00", "1234.5", "-3", "1,234.5"] {
        let by_function = eval(&format!("=VALUE(\"{}\")", spelling));
        let by_arithmetic = eval(&format!("=\"{}\"+0", spelling));
        assert_eq!(
            by_function, by_arithmetic,
            "VALUE and +0 disagree about {:?}: {:?} vs {:?}",
            spelling, by_function, by_arithmetic
        );
    }
    // ...and the answers are Excel's, not merely equal to each other — a VALUE
    // that returned #VALUE! for everything would satisfy the loop above.
    assert_eq!(number("=VALUE(\"5%\")"), 0.05);
    assert_eq!(number("=VALUE(\"$5\")"), 5.0);
    assert_eq!(number("=VALUE(\"2020-01-01\")"), 43831.0);
    assert_eq!(number("=VALUE(\"12:00\")"), 0.5);
    // CONTROL: text that is not a number is still an error, so the fix did not
    // simply make VALUE permissive.
    assert_eq!(eval("=VALUE(\"apple\")"), EvalResult::Error(crate::cell::CellError::Value));
    assert_eq!(eval("=VALUE(\"\")"), EvalResult::Error(crate::cell::CellError::Value));
}

/// The infinity leak, which is the one of these that a later formula gets wrong
/// SILENTLY.
///
/// MEASURED BEFORE THE FIX: `=VALUE("inf")` put +INFINITY in a cell and
/// `=ISNUMBER(VALUE("inf"))` said TRUE. Rust's `f64::from_str` accepts `inf`,
/// `infinity` and `NaN`; Excel accepts none of them, and every comparison,
/// total and chart axis downstream of a non-finite cell is wrong without an
/// error anywhere to point at.
#[test]
fn no_spelling_of_infinity_survives_value_or_numbervalue() {
    for spelling in ["inf", "Inf", "INFINITY", "-inf", "NaN", "nan", "1e400"] {
        assert_eq!(
            eval(&format!("=VALUE(\"{}\")", spelling)),
            EvalResult::Error(crate::cell::CellError::Value),
            "VALUE({:?}) must be #VALUE!",
            spelling
        );
        assert_eq!(
            eval(&format!("=NUMBERVALUE(\"{}\")", spelling)),
            EvalResult::Error(crate::cell::CellError::Value),
            "NUMBERVALUE({:?}) must be #VALUE!",
            spelling
        );
    }
    assert_eq!(eval("=ISNUMBER(VALUE(\"inf\"))"), EvalResult::Boolean(false));
    // CONTROL: a number that merely LOOKS extreme is still a number.
    assert_eq!(number("=VALUE(\"1e300\")"), 1e300);
}

/// VALUE reads the WORKBOOK's dialect, which is the half `f64::from_str` could
/// never have.
#[test]
fn value_reads_the_workbooks_decimal_separator() {
    // On the shipping sv-SE build, the Swedish spelling is the number...
    assert_eq!(eval_in("=VALUE(\"1,5\")", "sv-SE"), EvalResult::Number(1.5));
    // ...and the foreign one is not. Exactly backwards before the fix.
    assert_eq!(
        eval_in("=VALUE(\"1.5\")", "sv-SE"),
        EvalResult::Error(crate::cell::CellError::Value)
    );
    // CONTROL: en-US is the mirror image, so this is a LOCALE test and not a
    // test that one spelling always wins.
    assert_eq!(eval_in("=VALUE(\"1.5\")", "en-US"), EvalResult::Number(1.5));
    assert_eq!(
        eval_in("=VALUE(\"1,5\")", "en-US"),
        EvalResult::Error(crate::cell::CellError::Value)
    );
}

/// NUMBERVALUE's separator arguments are the entire reason it exists: they must
/// beat the workbook's, or a Swedish workbook cannot read an American feed.
#[test]
fn numbervalue_honours_its_own_separators_over_the_workbooks() {
    // The example from Excel's own documentation.
    assert_eq!(number("=NUMBERVALUE(\"2.500,27\",\",\",\".\")"), 2500.27);
    // THE POINT OF THE FUNCTION: American separators inside a Swedish workbook.
    assert_eq!(number_in("=NUMBERVALUE(\"1,234.5\",\".\",\",\")", "sv-SE"), 1234.5);
    // ...and Swedish separators inside an American one.
    assert_eq!(number_in("=NUMBERVALUE(\"1.234,5\",\",\",\".\")", "en-US"), 1234.5);
    // OMITTED, the workbook's own separators are used — Excel's documented
    // default, and the reason this is not hard-coded to `.` and `,` any more.
    assert_eq!(number_in("=NUMBERVALUE(\"1,5\")", "sv-SE"), 1.5);
    assert_eq!(number_in("=NUMBERVALUE(\"1.5\")", "en-US"), 1.5);
    // Only the FIRST character of each argument is used, as in Excel.
    assert_eq!(number("=NUMBERVALUE(\"1.5\",\".x\")"), 1.5);
    // One character cannot be both separators.
    assert_eq!(
        eval("=NUMBERVALUE(\"1.5\",\".\",\".\")"),
        EvalResult::Error(crate::cell::CellError::Value)
    );
    // An EMPTY separator is a refusal, not a silent fallback to the workbook's:
    // it is a formula that computed its separator and got nothing.
    assert_eq!(
        eval("=NUMBERVALUE(\"1.5\",\"\")"),
        EvalResult::Error(crate::cell::CellError::Value)
    );
}

/// Excel's three documented oddities for NUMBERVALUE, none of which held.
#[test]
fn numbervalue_keeps_excels_percent_space_and_empty_rules() {
    // A trailing percent divides by a hundred. MEASURED BEFORE: #VALUE!.
    assert_eq!(number("=NUMBERVALUE(\"3.5%\")"), 0.035);
    // ...with a caller-named decimal separator that COLLIDES with the
    // workbook's group separator. The explicit argument wins and the default
    // steps aside; refusing here would reject a perfectly clear request.
    assert_eq!(number("=NUMBERVALUE(\"3,5%\",\",\")"), 0.035);
    // Whitespace is ignored ANYWHERE. MEASURED BEFORE: #VALUE!.
    assert_eq!(number("=NUMBERVALUE(\" 3 000 \")"), 3000.0);
    // Empty text is ZERO, not an error. MEASURED BEFORE: #VALUE!.
    assert_eq!(number("=NUMBERVALUE(\"\")"), 0.0);
    assert_eq!(number("=NUMBERVALUE(\"   \")"), 0.0);
    // CONTROL: two decimal separators is still an error, so "ignore spaces" did
    // not become "ignore everything".
    assert_eq!(
        eval("=NUMBERVALUE(\"1.2.3\")"),
        EvalResult::Error(crate::cell::CellError::Value)
    );
    // NUMBERVALUE has no currency or date rung, in Excel or here.
    assert_eq!(
        eval("=NUMBERVALUE(\"$5\")"),
        EvalResult::Error(crate::cell::CellError::Value)
    );
    assert_eq!(
        eval("=NUMBERVALUE(\"2020-01-01\")"),
        EvalResult::Error(crate::cell::CellError::Value)
    );
}

// ===========================================================================
// THE CRITERIA FAMILY — one parser, on BOTH sides
// ===========================================================================

/// A1=1.5, A2=2.5 — two plain numbers, so the only variable is how the
/// CRITERIA's characters are read.
fn two_numbers() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.5));
    g.set_cell(1, 0, Cell::new_number(2.5));
    g
}

/// MEASURED BEFORE THE FIX, on the shipping sv-SE default: `">1,5"` — the
/// user's own decimal spelling — matched NOTHING, while the foreign `">1.5"`
/// matched. `parse_criteria` was on Rust's `f64::from_str`, which has no
/// locale at all.
///
/// A criteria that silently selects the empty set is the worst shape of wrong
/// answer there is: every SUMIF over it is a confident, unremarkable zero.
#[test]
fn criteria_read_numbers_in_the_workbooks_own_dialect() {
    let g = two_numbers();

    // sv-SE: the Swedish spelling selects, in both the comparison and the
    // exact-match form.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\">1,5\")", "sv-SE"), 1.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\"1,5\")", "sv-SE"), 1.0);
    assert_eq!(number_grid_in(&g, "=SUMIF(A1:A2,\">1,5\")", "sv-SE"), 2.5);
    // ...and the FOREIGN spelling does not. Before the fix this was the one
    // that worked, which is the same defect seen from the other side.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\"1.5\")", "sv-SE"), 0.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\">1.5\")", "sv-SE"), 0.0);

    // en-US IS THE MIRROR IMAGE — the CONTROL that makes the block above a
    // locale test rather than a test that commas always win.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\">1.5\")", "en-US"), 1.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\"1.5\")", "en-US"), 1.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\">1,5\")", "en-US"), 0.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,\"1,5\")", "en-US"), 0.0);

    // A NUMERIC criteria is dialect-free and must select in both, so a fix that
    // simply broke criteria matching cannot pass.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,1.5)", "sv-SE"), 1.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A2,1.5)", "en-US"), 1.0);
}

/// A1 is the NUMBER 100; A2..A5 are TEXT: "100", "5%", "$200", "2020-01-01".
fn numbers_and_number_shaped_text() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(100.0));
    g.set_cell(1, 0, Cell::new_text("100".to_string()));
    g.set_cell(2, 0, Cell::new_text("5%".to_string()));
    g.set_cell(3, 0, Cell::new_text("$200".to_string()));
    g.set_cell(4, 0, Cell::new_text("2020-01-01".to_string()));
    g
}

/// THE ASYMMETRY, PINNED CLOSED. `matches_criteria` had been moved to the rich
/// arithmetic-coercion parser while `parse_criteria` was left on
/// `f64::from_str`, so which reading you got depended on WHICH SIDE OF THE
/// COMPARISON a spelling sat on.
///
/// MEASURED BEFORE THE FIX: `=COUNTIF(A1:A5,0.05)` answered 1 — it counted the
/// TEXT cell that reads `5%` on screen. A criteria is not an operator: nothing
/// has demanded a number of it, so it compares against the value as STORED, and
/// the presentational spellings (percent, currency, date) are off on BOTH
/// sides. `ParsePolicy::CRITERIA` carries that decision.
#[test]
fn a_criteria_and_a_cell_are_read_by_the_same_parser() {
    let g = numbers_and_number_shaped_text();

    // The three presentational spellings, from the NUMERIC side. Each was a
    // silent match before.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,0.05)", "en-US"), 0.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,200)", "en-US"), 0.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,43831)", "en-US"), 0.0);
    assert_eq!(number_grid_in(&g, "=SUMIF(A1:A5,0.05)", "en-US"), 0.0);

    // ...and from the TEXT side, which is what "the same parser on both sides"
    // means: the criteria "5%" is not 0.05 either, so it matches the cell that
    // literally holds those characters and nothing else.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,\"5%\")", "en-US"), 1.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,\"$200\")", "en-US"), 1.0);

    // THE CONTROL, and it is the one that must not be lost: a PLAIN number
    // written as text is still matched by a numeric criteria, in both
    // directions. Excel's criteria matching is loose about that on purpose —
    // it is why a column silently turned into text still counts — and the fix
    // narrows the SPELLINGS, not the coercion itself.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,100)", "en-US"), 2.0);
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,\"100\")", "en-US"), 2.0);
    // The comparison form agrees: the number 100 and the text "100", and
    // neither the currency nor the date text.
    assert_eq!(number_grid_in(&g, "=COUNTIF(A1:A5,\">50\")", "en-US"), 2.0);
}

/// THE PASS CACHE IS A THIRD READING OF THE SAME QUESTION, and it had the old
/// one.
///
/// `lookup_cache::CriteriaIndex` pre-buckets a range so COUNTIF can answer from
/// a sorted vector instead of a scan, and it bucketed by `as_number` — the rich
/// arithmetic reading. That made `=COUNTIF(A1:A5,0.05)` answer 1 when the pass
/// cache happened to be live and 0 when it was not: the same formula, the same
/// workbook, two answers depending on whether a recalculation had a pass open.
/// The cache's one inviolable invariant is that it agrees with the scan.
#[test]
fn the_criteria_cache_agrees_with_the_scan_about_number_shaped_text() {
    let g = numbers_and_number_shaped_text();
    for f in [
        "=COUNTIF(A1:A5,0.05)",
        "=COUNTIF(A1:A5,200)",
        "=COUNTIF(A1:A5,100)",
        "=COUNTIF(A1:A5,\"100\")",
        "=COUNTIF(A1:A5,\"5%\")",
        "=COUNTIF(A1:A5,\">50\")",
        "=COUNTIF(A1:A5,\"<>100\")",
    ] {
        let scanned = eval_grid_in(&g, f, "en-US");
        let cached = {
            let _pass = crate::lookup_cache::begin_pass();
            // Twice: the first call BUILDS the index and the second HITS it,
            // and a build/hit disagreement is its own class of bug.
            let first = eval_grid_in(&g, f, "en-US");
            let second = eval_grid_in(&g, f, "en-US");
            assert_eq!(first, second, "index build vs hit mismatch for {}", f);
            first
        };
        assert_eq!(scanned, cached, "cache diverged from scan for {}", f);
    }
}

/// The percent knob is POLICY, and every caller's answer is asserted here so
/// that adding a fifth policy cannot quietly inherit the wrong one.
#[test]
fn the_percent_spelling_is_on_for_arithmetic_and_off_for_criteria() {
    assert_eq!(parse("5%", us(), ParsePolicy::COERCION), Some(0.05));
    assert_eq!(parse("5%", us(), ParsePolicy::ENTRY), Some(0.05));
    assert_eq!(parse("5%", us(), ParsePolicy::NUMBERVALUE), Some(0.05));
    assert_eq!(parse("5%", us(), ParsePolicy::CRITERIA), None);
    // CONTROL: the same policy reads a PLAIN number, so "criteria refuses
    // everything" would not pass.
    assert_eq!(parse("5", us(), ParsePolicy::CRITERIA), Some(5.0));
    assert_eq!(parse("1,234.5", us(), ParsePolicy::CRITERIA), Some(1234.5));
    assert_eq!(parse("1,5", se(), ParsePolicy::CRITERIA), Some(1.5));
    // The other two presentational spellings are off for criteria too.
    assert_eq!(parse("$5", us(), ParsePolicy::CRITERIA), None);
    assert_eq!(parse("2020-01-01", us(), ParsePolicy::CRITERIA), None);
    assert_eq!(parse("12:00", us(), ParsePolicy::CRITERIA), None);
}

// ===========================================================================
// WHAT MUST NOT HAVE CHANGED
// ===========================================================================

#[test]
fn comparison_still_ranks_by_type_and_does_not_coerce_text() {
    // THE REGRESSION GUARD FOR THE PREVIOUS AGENT'S WORK. The parser above made
    // `as_number` accept far more text than it used to; if a comparison ever
    // routed through it, `="5"=5` would become TRUE and Excel's type ranking
    // (number < text < FALSE < TRUE) would collapse.
    assert_eq!(eval("=\"5\"=5"), EvalResult::Boolean(false));
    assert_eq!(eval("=\"5\">5"), EvalResult::Boolean(true));
    assert_eq!(eval("=5>\"5\""), EvalResult::Boolean(false));
    // Any text outranks any number, however large the number and small the text.
    assert_eq!(eval("=\"0\">999999"), EvalResult::Boolean(true));
    // ...and a boolean outranks any text.
    assert_eq!(eval("=FALSE>\"zzz\""), EvalResult::Boolean(true));
}

#[test]
fn aggregates_still_coerce_only_what_was_typed_directly() {
    // The direct-vs-indirect rule the previous agent landed. The widened parser
    // must not leak into the INDIRECT path: `=SUM({1,"2",TRUE})` stays 1 even
    // though "2" now parses, because Excel ignores a text value that arrived
    // inside an array.
    assert_eq!(number("=SUM(1,\"2\",TRUE)"), 4.0);
    assert_eq!(number("=SUM({1,\"2\",TRUE})"), 1.0);
    // ...and the same holds for the spellings the parser newly understands.
    assert_eq!(number("=SUM(1,\"50%\")"), 1.5);
    assert_eq!(number("=SUM({1,\"50%\"})"), 1.0);
}

#[test]
fn arithmetic_over_arrays_still_lifts_and_still_coerces_each_element() {
    // The array-lift suite's contract, re-checked from this side because the
    // lifted path reduces through the very methods this file changed.
    let grid = Grid::new();
    let ast = parser::parse("={\"1\",\"2\",\"3\"}+1").expect("parses");
    let out = Evaluator::new(&grid).evaluate(&ast);
    // Flattened, because a lifted row is an Array OF Arrays: the shape is the
    // array suite's business and the coercion of each element is this file's.
    fn flatten(value: &EvalResult, into: &mut Vec<f64>) {
        match value {
            EvalResult::Array(items) => items.iter().for_each(|i| flatten(i, into)),
            EvalResult::Number(n) => into.push(*n),
            other => panic!("expected numbers, got {:?}", other),
        }
    }
    let mut flat: Vec<f64> = Vec::new();
    flatten(&out, &mut flat);
    assert_eq!(flat, vec![2.0, 3.0, 4.0]);
}
