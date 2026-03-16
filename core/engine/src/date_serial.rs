//! FILENAME: core/engine/src/date_serial.rs
//! PURPOSE: Excel-compatible date serial number system.
//! CONTEXT: Excel stores dates as serial numbers (days since 1900-01-01).
//! Includes the intentional Lotus 123 bug where 1900 is treated as a leap year
//! (serial 60 = Feb 29, 1900 which never existed).

use std::time::SystemTime;

/// Converts year/month/day to an Excel serial date number.
/// Supports month overflow (e.g., month=13 -> Jan of next year).
pub fn date_to_serial(year: i32, month: i32, day: i32) -> f64 {
    // Normalize month overflow/underflow
    let mut y = year;
    let mut m = month;
    if m < 1 || m > 12 {
        let adj = m - 1;
        y += adj.div_euclid(12);
        m = adj.rem_euclid(12) + 1;
    }

    // Days from 1900-01-01 to start of year
    let mut serial: i64 = 0;
    if y >= 1900 {
        for yr in 1900..y {
            serial += if is_leap_year_excel(yr) { 366 } else { 365 };
        }
    }

    // Days from start of year to start of month
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for mn in 1..m {
        serial += month_days[mn as usize] as i64;
        if mn == 2 && is_leap_year_excel(y) {
            serial += 1;
        }
    }

    // Add days (serial 1 = Jan 1, 1900)
    serial += day as i64;

    serial as f64
}

/// Converts an Excel serial date to (year, month, day).
pub fn serial_to_date(serial: i64) -> (i32, u32, u32) {
    if serial < 1 {
        return (1900, 1, 1);
    }

    // Handle the Excel 1900 leap year bug
    // Serial 60 = Feb 29, 1900 (doesn't exist, but Excel treats it as valid)
    if serial == 60 {
        return (1900, 2, 29);
    }

    let mut remaining = if serial > 60 { serial - 1 } else { serial }; // Adjust for bug after serial 60

    // serial 1 = Jan 1, 1900
    remaining -= 1; // Now 0 = Jan 1, 1900

    let mut year = 1900;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let mut month = 1u32;
    loop {
        let dim = days_in_month(year, month) as i64;
        if remaining < dim {
            break;
        }
        remaining -= dim;
        month += 1;
    }

    let day = remaining as u32 + 1;
    (year, month, day)
}

/// Returns the fractional time part of a serial number as (hours, minutes, seconds).
pub fn serial_to_time(serial: f64) -> (u32, u32, u32) {
    let frac = serial.fract().abs();
    let total_seconds = (frac * 86400.0).round() as u64;
    let hours = (total_seconds / 3600) as u32;
    let minutes = ((total_seconds % 3600) / 60) as u32;
    let seconds = (total_seconds % 60) as u32;
    (hours, minutes, seconds)
}

/// Returns today's date as an Excel serial number.
pub fn today_serial() -> f64 {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let unix_days = duration.as_secs() / 86400;
    // Unix epoch (1970-01-01) = Excel serial 25569
    (unix_days as f64) + 25569.0
}

/// Returns current date+time as an Excel serial number with fractional time.
pub fn now_serial() -> f64 {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = duration.as_secs_f64();
    let unix_days = total_secs / 86400.0;
    unix_days + 25569.0
}

/// Number of days in a given month (standard Gregorian, not the Excel bug).
pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(year) { 29 } else { 28 },
        _ => 30,
    }
}

/// Standard Gregorian leap year check.
pub fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Excel's leap year check (1900 is treated as leap year due to Lotus 123 bug).
fn is_leap_year_excel(year: i32) -> bool {
    if year == 1900 { true } else { is_leap_year(year) }
}

/// Returns the day of week: 0=Sunday, 1=Monday, ..., 6=Saturday.
pub fn weekday(serial: i64) -> i32 {
    // Serial 1 = Jan 1, 1900 = Sunday (day 0)
    // But we need to account for the Excel leap year bug
    let adj = if serial >= 60 { serial } else { serial };
    ((adj - 1) % 7) as i32  // 0=Sunday for serial 1
}

/// Is the given serial a weekend (Saturday or Sunday)?
fn is_weekend(serial: i64) -> bool {
    let dow = weekday(serial);
    dow == 0 || dow == 6
}

/// Count working days between two serial dates (inclusive).
pub fn networkdays(start: i64, end: i64, holidays: &[i64]) -> i64 {
    let (lo, hi) = if start <= end { (start, end) } else { (end, start) };
    let sign = if start <= end { 1i64 } else { -1i64 };
    let mut count = 0i64;
    for d in lo..=hi {
        if !is_weekend(d) && !holidays.contains(&d) {
            count += 1;
        }
    }
    count * sign
}

/// Returns the serial date after adding `days` working days from `start`.
pub fn workday(start: i64, days: i64, holidays: &[i64]) -> i64 {
    let direction = if days >= 0 { 1i64 } else { -1i64 };
    let mut remaining = days.abs();
    let mut current = start;
    while remaining > 0 {
        current += direction;
        if !is_weekend(current) && !holidays.contains(&current) {
            remaining -= 1;
        }
    }
    current
}

/// Add months to a date, clamping day to end of month if needed.
pub fn add_months(year: i32, month: i32, day: u32, months: i32) -> (i32, i32, u32) {
    let total_months = (year * 12 + month - 1) + months;
    let ny = total_months.div_euclid(12);
    let nm = total_months.rem_euclid(12) + 1;
    let max_day = days_in_month(ny, nm as u32);
    let nd = day.min(max_day);
    (ny, nm, nd)
}

/// DATEDIF years difference.
pub fn datedif_years(sy: i32, sm: u32, sd: u32, ey: i32, em: u32, ed: u32) -> i32 {
    let mut years = ey - sy;
    if em < sm || (em == sm && ed < sd) {
        years -= 1;
    }
    years.max(0)
}

/// DATEDIF months difference.
pub fn datedif_months(sy: i32, sm: u32, sd: u32, ey: i32, em: u32, ed: u32) -> i32 {
    let mut months = (ey - sy) * 12 + (em as i32 - sm as i32);
    if ed < sd {
        months -= 1;
    }
    months.max(0)
}

/// Parse a date string like "2024-01-15", "01/15/2024", "January 15, 2024".
pub fn parse_date_string(text: &str) -> Option<f64> {
    let text = text.trim();

    // Try ISO format: YYYY-MM-DD
    if let Some(serial) = try_parse_iso(text) {
        return Some(serial);
    }

    // Try US format: MM/DD/YYYY or M/D/YYYY
    if let Some(serial) = try_parse_us(text) {
        return Some(serial);
    }

    None
}

fn try_parse_iso(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.split('-').collect();
    if parts.len() != 3 { return None; }
    let year = parts[0].parse::<i32>().ok()?;
    let month = parts[1].parse::<i32>().ok()?;
    let day = parts[2].parse::<i32>().ok()?;
    if month < 1 || month > 12 || day < 1 || day > 31 { return None; }
    Some(date_to_serial(year, month, day))
}

fn try_parse_us(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.split('/').collect();
    if parts.len() != 3 { return None; }
    let month = parts[0].parse::<i32>().ok()?;
    let day = parts[1].parse::<i32>().ok()?;
    let year = parts[2].parse::<i32>().ok()?;
    if month < 1 || month > 12 || day < 1 || day > 31 { return None; }
    Some(date_to_serial(year, month, day))
}

/// Parse a time string like "14:30:00" or "2:30 PM".
pub fn parse_time_string(text: &str) -> Option<f64> {
    let text = text.trim().to_uppercase();
    let is_pm = text.contains("PM");
    let is_am = text.contains("AM");
    let clean = text.replace("AM", "").replace("PM", "").trim().to_string();
    let parts: Vec<&str> = clean.split(':').collect();
    if parts.is_empty() || parts.len() > 3 { return None; }
    let mut hours = parts[0].trim().parse::<u32>().ok()?;
    let minutes = if parts.len() >= 2 { parts[1].trim().parse::<u32>().ok()? } else { 0 };
    let seconds = if parts.len() == 3 { parts[2].trim().parse::<u32>().ok()? } else { 0 };
    if is_pm && hours < 12 { hours += 12; }
    if is_am && hours == 12 { hours = 0; }
    Some((hours as f64 * 3600.0 + minutes as f64 * 60.0 + seconds as f64) / 86400.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_date_to_serial_basic() {
        assert_eq!(date_to_serial(1900, 1, 1) as i64, 1);
        assert_eq!(date_to_serial(1900, 1, 31) as i64, 31);
        assert_eq!(date_to_serial(1900, 2, 28) as i64, 59);
        // The Excel leap year bug: serial 60 = Feb 29, 1900
        assert_eq!(date_to_serial(1900, 3, 1) as i64, 61);
    }

    #[test]
    fn test_serial_to_date_basic() {
        assert_eq!(serial_to_date(1), (1900, 1, 1));
        assert_eq!(serial_to_date(59), (1900, 2, 28));
        assert_eq!(serial_to_date(60), (1900, 2, 29)); // Bug date
        assert_eq!(serial_to_date(61), (1900, 3, 1));
    }

    #[test]
    fn test_modern_dates() {
        // Jan 1, 2024 should be serial 45292
        let serial = date_to_serial(2024, 1, 1) as i64;
        let (y, m, d) = serial_to_date(serial);
        assert_eq!((y, m, d), (2024, 1, 1));
    }

    #[test]
    fn test_weekday() {
        // Jan 1, 1900 = Sunday
        assert_eq!(weekday(1), 0); // Sunday
        assert_eq!(weekday(7), 6); // Saturday
        assert_eq!(weekday(8), 0); // Sunday again
    }

    #[test]
    fn test_days_in_month() {
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2023, 2), 28);
        assert_eq!(days_in_month(2024, 1), 31);
    }
}
