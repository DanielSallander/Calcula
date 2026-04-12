//! FILENAME: core/engine/src/number_format.rs
//! PURPOSE: Number formatting utilities for displaying cell values.
//! CONTEXT: This module handles the conversion of raw numeric values to
//! formatted display strings based on the cell's NumberFormat setting.

use crate::custom_format::{self, FormatResult};
use crate::locale::LocaleSettings;
use crate::style::{CurrencyPosition, NumberFormat};

/// Format a number according to the specified format and locale.
pub fn format_number(value: f64, format: &NumberFormat, locale: &LocaleSettings) -> String {
    match format {
        NumberFormat::General => format_general(value, locale),
        NumberFormat::Number {
            decimal_places,
            use_thousands_separator,
        } => format_decimal(value, *decimal_places, *use_thousands_separator, locale),
        NumberFormat::Currency {
            decimal_places,
            symbol,
            symbol_position,
        } => format_currency(value, *decimal_places, symbol, *symbol_position, locale),
        NumberFormat::Accounting {
            decimal_places,
            symbol,
            symbol_position,
        } => format_accounting_display(value, *decimal_places, symbol, *symbol_position, locale),
        NumberFormat::Fraction {
            denominator,
            max_digits,
        } => format_fraction(value, *denominator, *max_digits),
        NumberFormat::Percentage { decimal_places } => format_percentage(value, *decimal_places, locale),
        NumberFormat::Scientific { decimal_places } => format_scientific(value, *decimal_places),
        NumberFormat::Date { format: date_fmt } => format_date_number(value, date_fmt),
        NumberFormat::Time { format: time_fmt } => format_time_number(value, time_fmt),
        NumberFormat::Custom { format: custom_fmt } => format_custom(value, custom_fmt, locale),
    }
}

/// Format a number in general format (auto-detect best representation).
fn format_general(value: f64, locale: &LocaleSettings) -> String {
    if value == 0.0 {
        return "0".to_string();
    }

    let abs_value = value.abs();

    // Use scientific notation for very large or very small numbers
    if abs_value >= 1e10 || (abs_value < 1e-4 && abs_value > 0.0) {
        let s = format!("{:.5e}", value)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string();
        return localize_decimal_output(&s, locale);
    }

    // For integers, don't show decimal point
    if value.fract() == 0.0 && abs_value < 1e15 {
        return format!("{:.0}", value);
    }

    // For decimals, show up to 10 significant digits but trim trailing zeros
    let formatted = format!("{:.10}", value);
    let trimmed = formatted
        .trim_end_matches('0')
        .trim_end_matches('.');
    localize_decimal_output(trimmed, locale)
}

/// Replace '.' with locale decimal separator in formatted output.
fn localize_decimal_output(s: &str, locale: &LocaleSettings) -> String {
    if locale.decimal_separator == '.' {
        s.to_string()
    } else {
        s.replace('.', &locale.decimal_separator.to_string())
    }
}

/// Format a number with specified decimal places and optional thousands separator.
fn format_decimal(value: f64, decimal_places: u8, use_thousands_separator: bool, locale: &LocaleSettings) -> String {
    let rounded = format!("{:.prec$}", value, prec = decimal_places as usize);

    if use_thousands_separator {
        add_thousands_separator(&rounded, locale)
    } else {
        localize_decimal_output(&rounded, locale)
    }
}

/// Add thousands separators to a numeric string, using locale-appropriate characters.
fn add_thousands_separator(s: &str, locale: &LocaleSettings) -> String {
    let parts: Vec<&str> = s.split('.').collect();
    let integer_part = parts[0];
    let decimal_part = parts.get(1);

    let negative = integer_part.starts_with('-');
    let digits: String = integer_part.chars().filter(|c| c.is_ascii_digit()).collect();

    let mut result = String::new();
    let len = digits.len();

    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            result.push(locale.thousands_separator);
        }
        result.push(c);
    }

    if negative {
        result = format!("-{}", result);
    }

    if let Some(decimal) = decimal_part {
        result.push(locale.decimal_separator);
        result.push_str(decimal);
    }

    result
}

/// Format a number as currency.
fn format_currency(
    value: f64,
    decimal_places: u8,
    symbol: &str,
    position: CurrencyPosition,
    locale: &LocaleSettings,
) -> String {
    let formatted = add_thousands_separator(&format!("{:.prec$}", value.abs(), prec = decimal_places as usize), locale);

    let with_symbol = match position {
        CurrencyPosition::Before => format!("{}{}", symbol, formatted),
        CurrencyPosition::After => format!("{}{}", formatted, symbol),
    };

    if value < 0.0 {
        format!("({})", with_symbol)
    } else {
        with_symbol
    }
}

/// Parts of an accounting-formatted value for split rendering.
/// The symbol is drawn left-aligned and the value right-aligned in the cell.
#[derive(Debug, Clone)]
pub struct AccountingParts {
    /// Currency symbol text (e.g., "$", "EUR")
    pub symbol: String,
    /// Whether the symbol appears before the value
    pub symbol_before: bool,
    /// Formatted number part (e.g., "1,234.00", "(1,234.00)", "-")
    pub value: String,
}

/// Format a number in accounting style, returning the split parts for rendering.
pub fn format_accounting_parts(
    value: f64,
    decimal_places: u8,
    symbol: &str,
    position: CurrencyPosition,
    locale: &LocaleSettings,
) -> AccountingParts {
    let value_text = if value == 0.0 {
        // Dash for zero values
        "-".to_string()
    } else {
        let formatted = add_thousands_separator(
            &format!("{:.prec$}", value.abs(), prec = decimal_places as usize),
            locale,
        );
        if value < 0.0 {
            format!("({})", formatted)
        } else {
            format!("{} ", formatted) // trailing space to align with closing paren
        }
    };

    AccountingParts {
        symbol: symbol.to_string(),
        symbol_before: matches!(position, CurrencyPosition::Before),
        value: value_text,
    }
}

/// Format a number in accounting style as a single display string (fallback).
fn format_accounting_display(
    value: f64,
    decimal_places: u8,
    symbol: &str,
    position: CurrencyPosition,
    locale: &LocaleSettings,
) -> String {
    let parts = format_accounting_parts(value, decimal_places, symbol, position, locale);
    if parts.symbol_before {
        format!("{} {}", parts.symbol, parts.value)
    } else {
        format!("{} {}", parts.value, parts.symbol)
    }
}

// ============================================================================
// FRACTION FORMATTING
// ============================================================================

/// Find the best fraction approximation of `frac` (0.0..1.0) with
/// numerator and denominator each having at most `max_digits` digits.
/// Returns (numerator, denominator). denominator is always >= 1.
fn best_fit_fraction(frac: f64, max_digits: u8) -> (u64, u64) {
    if frac <= 0.0 {
        return (0, 1);
    }
    let max_denom = match max_digits {
        1 => 9u64,
        2 => 99,
        3 => 999,
        _ => 9,
    };

    // Stern-Brocot / mediant search for best rational approximation
    let mut best_num = 0u64;
    let mut best_den = 1u64;
    let mut best_err = frac.abs();

    // Simple brute-force for small denominators — fast enough for max 999
    for d in 1..=max_denom {
        let n = (frac * d as f64).round() as u64;
        if n == 0 {
            continue;
        }
        // Check max_digits constraint on numerator
        let max_num = match max_digits {
            1 => 9u64,
            2 => 99,
            3 => 999,
            _ => 9,
        };
        if n > max_num {
            continue;
        }
        let err = (frac - (n as f64 / d as f64)).abs();
        if err < best_err {
            best_err = err;
            best_num = n;
            best_den = d;
            if err < 1e-12 {
                break;
            }
        }
    }

    // Reduce to lowest terms
    let g = gcd(best_num, best_den);
    (best_num / g, best_den / g)
}

/// Find the nearest fraction with a fixed denominator.
/// Returns the numerator.
fn fixed_denom_fraction(frac: f64, denom: u32) -> u64 {
    (frac * denom as f64).round() as u64
}

/// Greatest common divisor (Euclidean algorithm).
fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Format a number as a fraction string.
/// `denominator`: Some(d) for fixed denominator, None for best-fit.
/// `max_digits`: max digits in numerator/denominator for best-fit mode.
pub fn format_fraction(value: f64, denominator: Option<u32>, max_digits: u8) -> String {
    let negative = value < 0.0;
    let abs_val = value.abs();
    let whole = abs_val.floor() as u64;
    let frac = abs_val - whole as f64;

    let (numer, denom) = if let Some(fixed_d) = denominator {
        let n = fixed_denom_fraction(frac, fixed_d);
        (n, fixed_d as u64)
    } else {
        best_fit_fraction(frac, max_digits)
    };

    // Handle carry: e.g., 2.99 with halves => numer == denom
    let (whole, numer) = if numer >= denom && denom > 0 {
        (whole + numer / denom, numer % denom)
    } else {
        (whole, numer)
    };

    let sign = if negative { "-" } else { "" };

    if numer == 0 {
        // Pure integer
        format!("{}{}", sign, whole)
    } else if whole == 0 {
        format!("{}{}/{}", sign, numer, denom)
    } else {
        format!("{}{} {}/{}", sign, whole, numer, denom)
    }
}

/// Format a fraction for the custom format engine.
/// Returns (whole_str, numerator_str, denominator_str).
pub fn fraction_parts(value: f64, denominator: Option<u32>, max_digits: u8) -> (i64, u64, u64) {
    let abs_val = value.abs();
    let whole = abs_val.floor() as u64;
    let frac = abs_val - whole as f64;

    let (numer, denom) = if let Some(fixed_d) = denominator {
        let n = fixed_denom_fraction(frac, fixed_d);
        (n, fixed_d as u64)
    } else {
        best_fit_fraction(frac, max_digits)
    };

    // Handle carry
    let (whole, numer) = if numer >= denom && denom > 0 {
        (whole + numer / denom, numer % denom)
    } else {
        (whole, numer)
    };

    let signed_whole = if value < 0.0 { -(whole as i64) } else { whole as i64 };
    (signed_whole, numer, denom)
}

/// Format a number as percentage.
fn format_percentage(value: f64, decimal_places: u8, locale: &LocaleSettings) -> String {
    let percentage = value * 100.0;
    let s = format!("{:.prec$}%", percentage, prec = decimal_places as usize);
    localize_decimal_output(&s, locale)
}

/// Format a number in scientific notation.
fn format_scientific(value: f64, decimal_places: u8) -> String {
    format!("{:.prec$e}", value, prec = decimal_places as usize)
        .replace("e", "E")
}

/// Format a number as a date (Excel serial date number).
/// Excel dates: 1 = January 1, 1900
fn format_date_number(value: f64, format: &str) -> String {
    // Excel serial date conversion
    // Note: Excel has a bug where it thinks 1900 was a leap year
    let days = value.floor() as i64;
    
    if days < 1 {
        return value.to_string(); // Not a valid date
    }

    // Calculate date from serial number
    // Adjust for Excel's leap year bug (day 60 = Feb 29, 1900 which didn't exist)
    let adjusted_days = if days >= 60 { days - 1 } else { days };
    
    // Days since Dec 31, 1899
    let base_date = chrono_lite_date(adjusted_days);
    
    match base_date {
        Some((year, month, day)) => {
            format
                .replace("YYYY", &format!("{:04}", year))
                .replace("YY", &format!("{:02}", year % 100))
                .replace("MM", &format!("{:02}", month))
                .replace("DD", &format!("{:02}", day))
                .replace("M", &month.to_string())
                .replace("D", &day.to_string())
        }
        None => value.to_string(),
    }
}

/// Simple date calculation without external dependencies.
/// Returns (year, month, day) for a given number of days since Dec 31, 1899.
fn chrono_lite_date(days: i64) -> Option<(i32, u32, u32)> {
    if days < 1 {
        return None;
    }

    let mut remaining = days;
    let mut year = 1900i32;

    // Find the year
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining <= days_in_year as i64 {
            break;
        }
        remaining -= days_in_year as i64;
        year += 1;
    }

    // Find the month and day
    let months_days: [u32; 12] = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u32;
    for &days_in_month in &months_days {
        if remaining <= days_in_month as i64 {
            return Some((year, month, remaining as u32));
        }
        remaining -= days_in_month as i64;
        month += 1;
    }

    None
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Format a number as time (fraction of a day).
fn format_time_number(value: f64, format: &str) -> String {
    let fraction = value.fract();
    let total_seconds = (fraction * 86400.0).round() as u32;
    
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    let is_pm = hours >= 12;
    let hours_12 = if hours == 0 { 12 } else if hours > 12 { hours - 12 } else { hours };

    format
        .replace("HH", &format!("{:02}", hours))
        .replace("H", &hours.to_string())
        .replace("hh", &format!("{:02}", hours_12))
        .replace("h", &hours_12.to_string())
        .replace("MM", &format!("{:02}", minutes))
        .replace("mm", &format!("{:02}", minutes))
        .replace("SS", &format!("{:02}", seconds))
        .replace("ss", &format!("{:02}", seconds))
        .replace("AM/PM", if is_pm { "PM" } else { "AM" })
        .replace("am/pm", if is_pm { "pm" } else { "am" })
}

/// Format a number using a custom format string (full Excel-compatible engine).
fn format_custom(value: f64, format: &str, locale: &LocaleSettings) -> String {
    custom_format::format_custom_value(value, format, locale).text
}

/// Format a number and return both the display string and optional color override.
/// The color is only returned for Custom formats that include [Color] tokens.
pub fn format_number_with_color(value: f64, format: &NumberFormat, locale: &LocaleSettings) -> FormatResult {
    match format {
        NumberFormat::Custom { format: custom_fmt } => {
            custom_format::format_custom_value(value, custom_fmt, locale)
        }
        NumberFormat::Accounting {
            decimal_places,
            symbol,
            symbol_position,
        } => {
            let parts = format_accounting_parts(value, *decimal_places, symbol, *symbol_position, locale);
            let text = if parts.symbol_before {
                format!("{} {}", parts.symbol, parts.value)
            } else {
                format!("{} {}", parts.value, parts.symbol)
            };
            FormatResult {
                text,
                color: None,
                accounting: Some(parts),
            }
        }
        other => FormatResult {
            text: format_number(value, other, locale),
            color: None,
            accounting: None,
        },
    }
}

/// Format a text value using the text section of a custom format.
/// For non-Custom formats, returns the text as-is with no color.
pub fn format_text_with_color(text: &str, format: &NumberFormat) -> FormatResult {
    match format {
        NumberFormat::Custom { format: custom_fmt } => {
            custom_format::format_custom_text(text, custom_fmt)
        }
        _ => FormatResult {
            text: text.to_string(),
            color: None,
            accounting: None,
        },
    }
}

/// Predefined number formats for common use cases.
pub mod presets {
    use super::*;

    pub fn general() -> NumberFormat {
        NumberFormat::General
    }

    pub fn number(decimal_places: u8) -> NumberFormat {
        NumberFormat::Number {
            decimal_places,
            use_thousands_separator: false,
        }
    }

    pub fn number_with_separators(decimal_places: u8) -> NumberFormat {
        NumberFormat::Number {
            decimal_places,
            use_thousands_separator: true,
        }
    }

    pub fn currency_usd(decimal_places: u8) -> NumberFormat {
        NumberFormat::Currency {
            decimal_places,
            symbol: "$".to_string(),
            symbol_position: CurrencyPosition::Before,
        }
    }

    pub fn currency_eur(decimal_places: u8) -> NumberFormat {
        NumberFormat::Currency {
            decimal_places,
            symbol: "EUR ".to_string(),
            symbol_position: CurrencyPosition::Before,
        }
    }

    pub fn currency_sek(decimal_places: u8) -> NumberFormat {
        NumberFormat::Currency {
            decimal_places,
            symbol: " kr".to_string(),
            symbol_position: CurrencyPosition::After,
        }
    }

    pub fn percentage(decimal_places: u8) -> NumberFormat {
        NumberFormat::Percentage { decimal_places }
    }

    pub fn scientific(decimal_places: u8) -> NumberFormat {
        NumberFormat::Scientific { decimal_places }
    }

    pub fn date_iso() -> NumberFormat {
        NumberFormat::Date {
            format: "YYYY-MM-DD".to_string(),
        }
    }

    pub fn date_us() -> NumberFormat {
        NumberFormat::Date {
            format: "MM/DD/YYYY".to_string(),
        }
    }

    pub fn date_eu() -> NumberFormat {
        NumberFormat::Date {
            format: "DD/MM/YYYY".to_string(),
        }
    }

    pub fn time_24h() -> NumberFormat {
        NumberFormat::Time {
            format: "HH:MM:SS".to_string(),
        }
    }

    pub fn time_12h() -> NumberFormat {
        NumberFormat::Time {
            format: "hh:MM:SS AM/PM".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn us() -> LocaleSettings { LocaleSettings::invariant() }
    fn se() -> LocaleSettings { LocaleSettings::from_locale_id("sv-SE") }

    #[test]
    fn test_format_general() {
        let l = us();
        assert_eq!(format_general(0.0, &l), "0");
        assert_eq!(format_general(42.0, &l), "42");
        assert_eq!(format_general(3.14159, &l), "3.14159");
        assert_eq!(format_general(1000000000000.0, &l), "1000000000000");
    }

    #[test]
    fn test_format_general_swedish() {
        let l = se();
        assert_eq!(format_general(3.14159, &l), "3,14159");
    }

    #[test]
    fn test_format_decimal() {
        let l = us();
        assert_eq!(format_decimal(1234.567, 2, false, &l), "1234.57");
        assert_eq!(format_decimal(1234.567, 2, true, &l), "1,234.57");
        assert_eq!(format_decimal(1000000.0, 0, true, &l), "1,000,000");
    }

    #[test]
    fn test_format_decimal_swedish() {
        let l = se();
        assert_eq!(format_decimal(1234.567, 2, false, &l), "1234,57");
        assert_eq!(format_decimal(1234.567, 2, true, &l), "1\u{00A0}234,57");
    }

    #[test]
    fn test_format_currency() {
        let l = us();
        assert_eq!(
            format_currency(1234.56, 2, "$", CurrencyPosition::Before, &l),
            "$1,234.56"
        );
        assert_eq!(
            format_currency(-1234.56, 2, "$", CurrencyPosition::Before, &l),
            "($1,234.56)"
        );
        assert_eq!(
            format_currency(1234.56, 2, " kr", CurrencyPosition::After, &l),
            "1,234.56 kr"
        );
    }

    #[test]
    fn test_format_percentage() {
        let l = us();
        assert_eq!(format_percentage(0.5, 0, &l), "50%");
        assert_eq!(format_percentage(0.1234, 2, &l), "12.34%");
        assert_eq!(format_percentage(1.5, 1, &l), "150.0%");
    }

    #[test]
    fn test_format_scientific() {
        assert_eq!(format_scientific(1234.0, 2), "1.23E3");
        assert_eq!(format_scientific(0.00123, 3), "1.230E-3");
    }

    #[test]
    fn test_thousands_separator() {
        let l = us();
        assert_eq!(add_thousands_separator("1234567", &l), "1,234,567");
        assert_eq!(add_thousands_separator("123", &l), "123");
        assert_eq!(add_thousands_separator("-1234.56", &l), "-1,234.56");
    }

    #[test]
    fn test_format_fraction_best_fit_1() {
        // Best-fit with 1 digit: 0.5 -> 1/2
        assert_eq!(format_fraction(0.5, None, 1), "1/2");
        // 1.5 -> 1 1/2
        assert_eq!(format_fraction(1.5, None, 1), "1 1/2");
        // 0.25 -> 1/4
        assert_eq!(format_fraction(0.25, None, 1), "1/4");
        // Integer with no fraction
        assert_eq!(format_fraction(5.0, None, 1), "5");
    }

    #[test]
    fn test_format_fraction_best_fit_2() {
        // Best-fit with 2 digits: 0.333... -> close to 1/3
        let result = format_fraction(1.0 / 3.0, None, 2);
        assert_eq!(result, "1/3");
    }

    #[test]
    fn test_format_fraction_fixed_denom() {
        // Halves
        assert_eq!(format_fraction(1.5, Some(2), 1), "1 1/2");
        assert_eq!(format_fraction(2.0, Some(2), 1), "2");
        // Quarters
        assert_eq!(format_fraction(0.75, Some(4), 1), "3/4");
        assert_eq!(format_fraction(1.25, Some(4), 1), "1 1/4");
        // Eighths
        assert_eq!(format_fraction(0.125, Some(8), 1), "1/8");
    }

    #[test]
    fn test_format_fraction_negative() {
        assert_eq!(format_fraction(-1.5, None, 1), "-1 1/2");
        assert_eq!(format_fraction(-0.25, None, 1), "-1/4");
    }

    #[test]
    fn test_format_fraction_zero() {
        assert_eq!(format_fraction(0.0, None, 1), "0");
        assert_eq!(format_fraction(0.0, Some(4), 1), "0");
    }

    #[test]
    fn test_gcd() {
        assert_eq!(gcd(6, 4), 2);
        assert_eq!(gcd(15, 10), 5);
        assert_eq!(gcd(7, 3), 1);
        assert_eq!(gcd(0, 5), 5);
    }
}