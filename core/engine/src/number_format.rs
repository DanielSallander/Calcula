//! FILENAME: core/engine/src/number_format.rs
//! PURPOSE: Number formatting utilities for displaying cell values.
//! CONTEXT: This module handles the conversion of raw numeric values to
//! formatted display strings based on the cell's NumberFormat setting.

use crate::style::{CurrencyPosition, NumberFormat};

/// Format a number according to the specified format.
pub fn format_number(value: f64, format: &NumberFormat) -> String {
    match format {
        NumberFormat::General => format_general(value),
        NumberFormat::Number {
            decimal_places,
            use_thousands_separator,
        } => format_decimal(value, *decimal_places, *use_thousands_separator),
        NumberFormat::Currency {
            decimal_places,
            symbol,
            symbol_position,
        } => format_currency(value, *decimal_places, symbol, *symbol_position),
        NumberFormat::Percentage { decimal_places } => format_percentage(value, *decimal_places),
        NumberFormat::Scientific { decimal_places } => format_scientific(value, *decimal_places),
        NumberFormat::Date { format: date_fmt } => format_date_number(value, date_fmt),
        NumberFormat::Time { format: time_fmt } => format_time_number(value, time_fmt),
        NumberFormat::Custom { format: custom_fmt } => format_custom(value, custom_fmt),
    }
}

/// Format a number in general format (auto-detect best representation).
fn format_general(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }

    let abs_value = value.abs();

    // Use scientific notation for very large or very small numbers
    if abs_value >= 1e10 || (abs_value < 1e-4 && abs_value > 0.0) {
        return format!("{:.5e}", value)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string();
    }

    // For integers, don't show decimal point
    if value.fract() == 0.0 && abs_value < 1e15 {
        return format!("{:.0}", value);
    }

    // For decimals, show up to 10 significant digits but trim trailing zeros
    let formatted = format!("{:.10}", value);
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

/// Format a number with specified decimal places and optional thousands separator.
fn format_decimal(value: f64, decimal_places: u8, use_thousands_separator: bool) -> String {
    let rounded = format!("{:.prec$}", value, prec = decimal_places as usize);

    if use_thousands_separator {
        add_thousands_separator(&rounded)
    } else {
        rounded
    }
}

/// Add thousands separators to a numeric string.
fn add_thousands_separator(s: &str) -> String {
    let parts: Vec<&str> = s.split('.').collect();
    let integer_part = parts[0];
    let decimal_part = parts.get(1);

    let negative = integer_part.starts_with('-');
    let digits: String = integer_part.chars().filter(|c| c.is_ascii_digit()).collect();

    let mut result = String::new();
    let len = digits.len();

    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }

    if negative {
        result = format!("-{}", result);
    }

    if let Some(decimal) = decimal_part {
        result.push('.');
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
) -> String {
    let formatted = add_thousands_separator(&format!("{:.prec$}", value.abs(), prec = decimal_places as usize));

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

/// Format a number as percentage.
fn format_percentage(value: f64, decimal_places: u8) -> String {
    let percentage = value * 100.0;
    format!("{:.prec$}%", percentage, prec = decimal_places as usize)
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

/// Format a number using a custom format string.
/// Supports basic patterns like "0.00", "#,##0", etc.
fn format_custom(value: f64, format: &str) -> String {
    // Basic custom format support
    // Count decimal places from format
    let decimal_places = if let Some(dot_pos) = format.find('.') {
        format[dot_pos + 1..]
            .chars()
            .take_while(|c| *c == '0' || *c == '#')
            .count() as u8
    } else {
        0
    };

    let use_thousands = format.contains(',');

    format_decimal(value, decimal_places, use_thousands)
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

    #[test]
    fn test_format_general() {
        assert_eq!(format_general(0.0), "0");
        assert_eq!(format_general(42.0), "42");
        assert_eq!(format_general(3.14159), "3.14159");
        assert_eq!(format_general(1000000000000.0), "1000000000000");
    }

    #[test]
    fn test_format_decimal() {
        assert_eq!(format_decimal(1234.567, 2, false), "1234.57");
        assert_eq!(format_decimal(1234.567, 2, true), "1,234.57");
        assert_eq!(format_decimal(1000000.0, 0, true), "1,000,000");
    }

    #[test]
    fn test_format_currency() {
        assert_eq!(
            format_currency(1234.56, 2, "$", CurrencyPosition::Before),
            "$1,234.56"
        );
        assert_eq!(
            format_currency(-1234.56, 2, "$", CurrencyPosition::Before),
            "($1,234.56)"
        );
        assert_eq!(
            format_currency(1234.56, 2, " kr", CurrencyPosition::After),
            "1,234.56 kr"
        );
    }

    #[test]
    fn test_format_percentage() {
        assert_eq!(format_percentage(0.5, 0), "50%");
        assert_eq!(format_percentage(0.1234, 2), "12.34%");
        assert_eq!(format_percentage(1.5, 1), "150.0%");
    }

    #[test]
    fn test_format_scientific() {
        assert_eq!(format_scientific(1234.0, 2), "1.23E3");
        assert_eq!(format_scientific(0.00123, 3), "1.230E-3");
    }

    #[test]
    fn test_thousands_separator() {
        assert_eq!(add_thousands_separator("1234567"), "1,234,567");
        assert_eq!(add_thousands_separator("123"), "123");
        assert_eq!(add_thousands_separator("-1234.56"), "-1,234.56");
    }
}