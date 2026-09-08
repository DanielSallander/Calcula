//! FILENAME: core/insights/src/narrate/number.rs
// PURPOSE: Render a number the way the reader's locale writes numbers.
// CONTEXT: Every number in a narrated sentence goes through `engine`'s own
// formatter with an `engine::LocaleSettings`, NOT through `format!("{}")`.
// A sentence is read next to the cells it came from, and a Swedish user who
// sees "1 234,5" in the grid and "1234.5" in the summary of that grid has been
// shown two spellings of one number by one product. Rust's default formatting
// is en-US and there is no ambient locale to fall back on, so the settings are
// carried explicitly to every call.

use engine::style::NumberFormat;
use engine::{format_number, LocaleSettings};

/// What a non-finite number renders as. It should never reach here -- the
/// statistics return `None` instead of NaN -- but a template that printed
/// "NaN%" into a report would be worse than a visible placeholder.
pub const NOT_AVAILABLE: &str = "n/a";

/// A general-purpose number. Integers keep no decimals; everything else gets
/// as many as its magnitude can carry without noise.
pub fn num(value: f64, locale: &LocaleSettings) -> String {
    if !value.is_finite() {
        return NOT_AVAILABLE.to_string();
    }
    if value != 0.0 && value.abs() < 0.001 {
        // Below a thousandth every decimal choice below rounds to "0", which
        // would say a measured value is zero.
        return format_number(value, &NumberFormat::Scientific { decimal_places: 2 }, locale);
    }
    let decimal_places = if value.fract() == 0.0 && value.abs() < 1e15 {
        0
    } else if value.abs() >= 100.0 {
        1
    } else if value.abs() >= 1.0 {
        2
    } else {
        3
    };
    format_number(
        value,
        &NumberFormat::Number {
            decimal_places,
            use_thousands_separator: true,
        },
        locale,
    )
}

/// A count of things. Always an integer, always grouped.
pub fn count(value: usize, locale: &LocaleSettings) -> String {
    format_number(
        value as f64,
        &NumberFormat::Number {
            decimal_places: 0,
            use_thousands_separator: true,
        },
        locale,
    )
}

/// A FRACTION rendered as a percentage: `0.421` becomes `42.1%`.
pub fn pct(fraction: f64, locale: &LocaleSettings) -> String {
    if !fraction.is_finite() {
        return NOT_AVAILABLE.to_string();
    }
    format_number(
        fraction,
        &NumberFormat::Percentage { decimal_places: 1 },
        locale,
    )
}

/// A percentage that carries its own sign, for a change that can go either way.
pub fn signed_pct(fraction: f64, locale: &LocaleSettings) -> String {
    if !fraction.is_finite() {
        return NOT_AVAILABLE.to_string();
    }
    let body = pct(fraction, locale);
    if fraction > 0.0 {
        format!("+{}", body)
    } else {
        // A negative already carries its minus from the formatter; zero needs
        // no sign at all.
        body
    }
}

/// A unitless coefficient -- a correlation, an R-squared, a count of standard
/// deviations. Two decimals, no grouping: `0.87`, not `0.87` in one place and
/// `0.9` in another.
pub fn ratio(value: f64, locale: &LocaleSettings) -> String {
    if !value.is_finite() {
        return NOT_AVAILABLE.to_string();
    }
    format_number(
        value,
        &NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: false,
        },
        locale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn en() -> LocaleSettings {
        LocaleSettings::from_locale_id("en-US")
    }

    fn sv() -> LocaleSettings {
        LocaleSettings::from_locale_id("sv-SE")
    }

    #[test]
    fn a_swedish_locale_renders_a_comma_decimal() {
        let rendered = num(1234.5, &sv());
        assert!(
            rendered.contains(','),
            "sv-SE must use a decimal comma, got {rendered:?}"
        );
        assert!(
            !rendered.contains('.'),
            "sv-SE must not emit a decimal point, got {rendered:?}"
        );
        // sv-SE groups with a NON-BREAKING space (U+00A0), which is what Excel
        // writes too; asserting on a plain space here would pass for the wrong
        // reason on a build that lost the grouping entirely.
        assert_eq!(rendered, "1\u{00A0}234,5");
        assert_eq!(num(1234.5, &en()), "1,234.5");
    }

    #[test]
    fn an_integer_carries_no_decimals_in_either_locale() {
        assert_eq!(num(1234567.0, &en()), "1,234,567");
        assert_eq!(num(1234567.0, &sv()), "1\u{00A0}234\u{00A0}567");
    }

    #[test]
    fn a_percentage_is_a_fraction_times_a_hundred() {
        assert_eq!(pct(0.421, &en()), "42.1%");
        assert_eq!(pct(0.421, &sv()), "42,1%");
        assert_eq!(signed_pct(0.421, &en()), "+42.1%");
        assert_eq!(signed_pct(-0.05, &en()), "-5.0%");
    }

    #[test]
    fn a_coefficient_keeps_two_decimals() {
        assert_eq!(ratio(0.8712, &en()), "0.87");
        assert_eq!(ratio(0.8712, &sv()), "0,87");
    }

    #[test]
    fn a_value_too_small_to_round_is_not_printed_as_zero() {
        let rendered = num(0.0000123, &en());
        assert_ne!(rendered, "0.000");
        assert!(rendered.contains('E'), "expected scientific form, got {rendered:?}");
    }

    #[test]
    fn a_non_finite_number_never_reaches_a_sentence() {
        assert_eq!(num(f64::NAN, &en()), NOT_AVAILABLE);
        assert_eq!(pct(f64::INFINITY, &en()), NOT_AVAILABLE);
        assert_eq!(ratio(f64::NEG_INFINITY, &en()), NOT_AVAILABLE);
    }
}
