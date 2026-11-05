//! DAX `FORMAT(value, format_string)`: the format-string language Analysis
//! Services and Power BI read (Calcula BUG-0522).
//!
//! `FORMAT` used to compile to SQL `TO_CHAR`, which implements PostgreSQL's
//! template patterns, not DAX's: `FORMAT(x, "#,0.00")` was wrong in every
//! locale, and a measure that formats itself came out en-US-shaped under
//! sv-SE or de-DE. It now compiles to the local UDF `calcula_format`
//! ([`format_udf`]), which this module implements, in the culture the HOST
//! hands the engine (`Engine::set_format_culture`; Calcula passes its APP
//! locale). An expression containing `FORMAT` is never pushed to a source.
//!
//! # What is implemented
//!
//! The named formats -- "General Number", "Currency", "Fixed", "Standard",
//! "Percent", "Scientific", "Yes/No", "True/False", "On/Off", "General Date",
//! "Long Date", "Medium Date", "Short Date", "Long Time", "Medium Time",
//! "Short Time" -- and custom formats in the VBA-compatible token language
//! DAX documents:
//!
//! - numbers: up to three `;`-separated sections (positive; negative; zero),
//!   `0` / `#` digit placeholders, `.` the culture's decimal separator, `,`
//!   between digit placeholders the culture's group separator (and a `,`
//!   right before the decimal point or at the end scales by 1000), `%`
//!   (multiplies by 100), `E+` / `E-` / `e+` / `e-` scientific, `\x` and
//!   `"text"` literals; a single-section format writes a negative number
//!   with a leading `-`, and a decimal point with no digit after it is kept
//!   (`FORMAT(1, "#.##")` is `1.`, as in VBA);
//! - dates and times: `d dd ddd dddd ddddd dddddd`, `w ww`, `m mm mmm mmmm`
//!   (`m` right after an hour, or before `:s`, is the MINUTE), `q`, `y yy
//!   yyyy`, `h hh` (12-hour when the pattern has an AM/PM token, else
//!   24-hour), `n nn`, `s ss`, `AM/PM am/pm A/P a/p AMPM tt`, `c`, `ttttt`;
//!   `/` and `:` are the culture's date and time separators. Tokens are
//!   case-insensitive, so .NET-style `yyyy-MM-dd HH:mm:ss` reads the same.
//!
//! A number formatted with a date pattern is an OLE serial date (day 0 =
//! 1899-12-30); a date formatted with a number pattern is its serial. BLANK
//! formats to the empty string, as in DAX. Text is returned unchanged.

use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};

/// The culture `FORMAT` writes in: separators, currency, the named date and
/// time patterns, and the calendar names. Plain data -- the host builds it
/// from its own locale (Calcula: `engine::LocaleSettings`), so a measure
/// that formats itself agrees with every other number the app shows.
///
/// Date and time patterns are in the `FORMAT` token language itself
/// (`yyyy-mm-dd`, `dddd, mmmm d, yyyy`, `h:mm:ss AM/PM`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FormatCulture {
    /// BCP 47 tag, for diagnostics and identity (`en-US`).
    pub name: String,
    pub decimal_separator: String,
    pub group_separator: String,
    /// What `/` in a date pattern writes (`/` en-US, `-` sv-SE, `.` de-DE).
    pub date_separator: String,
    /// What `:` in a time pattern writes.
    pub time_separator: String,
    pub currency_symbol: String,
    /// `$1.00` (true) or `1,00 kr` (false).
    pub currency_symbol_before: bool,
    /// A space between the number and the symbol (`1,00 kr`).
    pub currency_space: bool,
    /// "Short Date" and `ddddd`.
    pub short_date: String,
    /// "Long Date" and `dddddd`.
    pub long_date: String,
    /// "Long Time" and `ttttt`.
    pub long_time: String,
    pub am_designator: String,
    pub pm_designator: String,
    /// January..December.
    pub months: [String; 12],
    pub months_short: [String; 12],
    /// Sunday..Saturday.
    pub days: [String; 7],
    pub days_short: [String; 7],
}

fn strings<const N: usize>(items: [&str; N]) -> [String; N] {
    items.map(str::to_string)
}

impl FormatCulture {
    /// English (United States): the engine's default.
    pub fn en_us() -> Self {
        FormatCulture {
            name: "en-US".into(),
            decimal_separator: ".".into(),
            group_separator: ",".into(),
            date_separator: "/".into(),
            time_separator: ":".into(),
            currency_symbol: "$".into(),
            currency_symbol_before: true,
            currency_space: false,
            short_date: "m/d/yyyy".into(),
            long_date: "dddd, mmmm d, yyyy".into(),
            long_time: "h:mm:ss AM/PM".into(),
            am_designator: "AM".into(),
            pm_designator: "PM".into(),
            months: strings([
                "January",
                "February",
                "March",
                "April",
                "May",
                "June",
                "July",
                "August",
                "September",
                "October",
                "November",
                "December",
            ]),
            months_short: strings([
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ]),
            days: strings([
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
            ]),
            days_short: strings(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]),
        }
    }

    /// Swedish (Sweden).
    pub fn sv_se() -> Self {
        FormatCulture {
            name: "sv-SE".into(),
            decimal_separator: ",".into(),
            group_separator: "\u{a0}".into(),
            date_separator: "-".into(),
            time_separator: ":".into(),
            currency_symbol: "kr".into(),
            currency_symbol_before: false,
            currency_space: true,
            short_date: "yyyy-mm-dd".into(),
            long_date: "\"den \"d mmmm yyyy".into(),
            long_time: "hh:mm:ss".into(),
            am_designator: "fm".into(),
            pm_designator: "em".into(),
            months: strings([
                "januari",
                "februari",
                "mars",
                "april",
                "maj",
                "juni",
                "juli",
                "augusti",
                "september",
                "oktober",
                "november",
                "december",
            ]),
            months_short: strings([
                "jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec",
            ]),
            days: strings([
                "s\u{f6}ndag",
                "m\u{e5}ndag",
                "tisdag",
                "onsdag",
                "torsdag",
                "fredag",
                "l\u{f6}rdag",
            ]),
            days_short: strings([
                "s\u{f6}n", "m\u{e5}n", "tis", "ons", "tor", "fre", "l\u{f6}r",
            ]),
        }
    }

    /// German (Germany).
    pub fn de_de() -> Self {
        FormatCulture {
            name: "de-DE".into(),
            decimal_separator: ",".into(),
            group_separator: ".".into(),
            date_separator: ".".into(),
            time_separator: ":".into(),
            currency_symbol: "\u{20ac}".into(),
            currency_symbol_before: false,
            currency_space: true,
            short_date: "dd.mm.yyyy".into(),
            long_date: "dddd, d. mmmm yyyy".into(),
            long_time: "hh:mm:ss".into(),
            am_designator: "AM".into(),
            pm_designator: "PM".into(),
            months: strings([
                "Januar",
                "Februar",
                "M\u{e4}rz",
                "April",
                "Mai",
                "Juni",
                "Juli",
                "August",
                "September",
                "Oktober",
                "November",
                "Dezember",
            ]),
            months_short: strings([
                "Jan", "Feb", "M\u{e4}r", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov",
                "Dez",
            ]),
            days: strings([
                "Sonntag",
                "Montag",
                "Dienstag",
                "Mittwoch",
                "Donnerstag",
                "Freitag",
                "Samstag",
            ]),
            days_short: strings(["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]),
        }
    }

    /// The built-in culture for a BCP 47 tag (`en-US`, `sv-SE`, `de-DE`,
    /// matched case-insensitively, `_` read as `-`), or `None` -- a host
    /// then builds one from its own locale data.
    pub fn builtin(tag: &str) -> Option<Self> {
        match tag.replace('_', "-").to_ascii_lowercase().as_str() {
            "en-us" => Some(Self::en_us()),
            "sv-se" => Some(Self::sv_se()),
            "de-de" => Some(Self::de_de()),
            _ => None,
        }
    }

    /// A stable identity of everything that changes output, for the UDF's
    /// registry version (and so the query-cache key).
    pub fn identity(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.hash(&mut h);
        h.finish()
    }
}

impl Default for FormatCulture {
    fn default() -> Self {
        Self::en_us()
    }
}

/// One value to format.
#[derive(Debug, Clone, PartialEq)]
pub enum FormatValue {
    Blank,
    Number(f64),
    DateTime(NaiveDateTime),
    Text(String),
    Bool(bool),
}

/// Day 0 of an OLE serial date.
fn ole_epoch() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(1899, 12, 30)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .unwrap_or_default()
}

fn serial_to_datetime(serial: f64) -> Option<NaiveDateTime> {
    if !serial.is_finite() || serial.abs() > 2_958_465.0 {
        return None;
    }
    let millis = (serial * 86_400_000.0).round() as i64;
    ole_epoch().checked_add_signed(chrono::Duration::milliseconds(millis))
}

fn datetime_to_serial(dt: &NaiveDateTime) -> f64 {
    let d = *dt - ole_epoch();
    d.num_milliseconds() as f64 / 86_400_000.0
}

/// `FORMAT(value, format)` in `culture`.
pub fn format_value(value: &FormatValue, format: &str, culture: &FormatCulture) -> String {
    match value {
        FormatValue::Blank => String::new(),
        FormatValue::Text(s) => s.clone(),
        FormatValue::Bool(b) => match named(format) {
            Some(Named::YesNo) => (if *b { "Yes" } else { "No" }).to_string(),
            Some(Named::TrueFalse) => (if *b { "True" } else { "False" }).to_string(),
            Some(Named::OnOff) => (if *b { "On" } else { "Off" }).to_string(),
            _ if format.trim().is_empty() => (if *b { "True" } else { "False" }).to_string(),
            _ => format_number(if *b { 1.0 } else { 0.0 }, format, culture),
        },
        FormatValue::Number(n) => format_number(*n, format, culture),
        FormatValue::DateTime(dt) => {
            if format.trim().is_empty() {
                return general_date(dt, culture);
            }
            match named(format) {
                Some(n) if n.is_date() => format_named_date(n, dt, culture),
                Some(_) => format_number(datetime_to_serial(dt), format, culture),
                None if is_date_pattern(format) => format_date_pattern(dt, format, culture),
                None => format_number(datetime_to_serial(dt), format, culture),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Named {
    GeneralNumber,
    Currency,
    Fixed,
    Standard,
    Percent,
    Scientific,
    YesNo,
    TrueFalse,
    OnOff,
    GeneralDate,
    LongDate,
    MediumDate,
    ShortDate,
    LongTime,
    MediumTime,
    ShortTime,
}

impl Named {
    fn is_date(self) -> bool {
        matches!(
            self,
            Named::GeneralDate
                | Named::LongDate
                | Named::MediumDate
                | Named::ShortDate
                | Named::LongTime
                | Named::MediumTime
                | Named::ShortTime
        )
    }
}

fn named(format: &str) -> Option<Named> {
    let f = format.trim().to_ascii_lowercase();
    Some(match f.as_str() {
        "general number" | "general" => Named::GeneralNumber,
        "currency" => Named::Currency,
        "fixed" => Named::Fixed,
        "standard" => Named::Standard,
        "percent" => Named::Percent,
        "scientific" => Named::Scientific,
        "yes/no" => Named::YesNo,
        "true/false" => Named::TrueFalse,
        "on/off" => Named::OnOff,
        "general date" => Named::GeneralDate,
        "long date" => Named::LongDate,
        "medium date" => Named::MediumDate,
        "short date" => Named::ShortDate,
        "long time" => Named::LongTime,
        "medium time" => Named::MediumTime,
        "short time" => Named::ShortTime,
        _ => return None,
    })
}

fn format_named_date(n: Named, dt: &NaiveDateTime, c: &FormatCulture) -> String {
    match n {
        Named::GeneralDate => general_date(dt, c),
        Named::LongDate => format_date_pattern(dt, &c.long_date, c),
        Named::MediumDate => format_date_pattern(dt, "dd-mmm-yy", c),
        Named::ShortDate => format_date_pattern(dt, &c.short_date, c),
        Named::LongTime => format_date_pattern(dt, &c.long_time, c),
        Named::MediumTime => format_date_pattern(dt, "hh:nn AM/PM", c),
        Named::ShortTime => format_date_pattern(dt, "hh:nn", c),
        _ => String::new(),
    }
}

/// "General Date": the short date, the long time, or both -- a date with no
/// time of day shows the date only, a time on day 0 the time only.
fn general_date(dt: &NaiveDateTime, c: &FormatCulture) -> String {
    let has_time = dt.time() != chrono::NaiveTime::MIN;
    let is_day_zero = dt.date() == ole_epoch().date();
    match (is_day_zero, has_time) {
        (true, true) => format_date_pattern(dt, &c.long_time, c),
        (_, false) => format_date_pattern(dt, &c.short_date, c),
        (false, true) => {
            let date = format_date_pattern(dt, &c.short_date, c);
            let time = format_date_pattern(dt, &c.long_time, c);
            format!("{date} {time}")
        }
    }
}

fn format_number(n: f64, format: &str, c: &FormatCulture) -> String {
    if !n.is_finite() {
        return if n.is_nan() {
            "NaN".into()
        } else if n > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if format.trim().is_empty() {
        return general_number(n, c);
    }
    match named(format) {
        Some(Named::GeneralNumber) => general_number(n, c),
        Some(Named::Currency) => {
            let body = custom_number(n.abs(), "#,##0.00", c);
            let with_symbol = if c.currency_symbol_before {
                format!(
                    "{}{}{}",
                    c.currency_symbol,
                    if c.currency_space { " " } else { "" },
                    body
                )
            } else {
                format!(
                    "{}{}{}",
                    body,
                    if c.currency_space { "\u{a0}" } else { "" },
                    c.currency_symbol
                )
            };
            if n < 0.0 && !is_all_zero(&body) {
                format!("-{with_symbol}")
            } else {
                with_symbol
            }
        }
        Some(Named::Fixed) => format_sections(n, "0.00", c),
        Some(Named::Standard) => format_sections(n, "#,##0.00", c),
        Some(Named::Percent) => format_sections(n, "0.00%", c),
        Some(Named::Scientific) => format_sections(n, "0.00E+00", c),
        Some(Named::YesNo) => (if n != 0.0 { "Yes" } else { "No" }).to_string(),
        Some(Named::TrueFalse) => (if n != 0.0 { "True" } else { "False" }).to_string(),
        Some(Named::OnOff) => (if n != 0.0 { "On" } else { "Off" }).to_string(),
        Some(date) => match serial_to_datetime(n) {
            Some(dt) => format_named_date(date, &dt, c),
            None => general_number(n, c),
        },
        None if is_date_pattern(format) => match serial_to_datetime(n) {
            Some(dt) => format_date_pattern(&dt, format, c),
            None => general_number(n, c),
        },
        None => format_sections(n, format, c),
    }
}

fn is_all_zero(s: &str) -> bool {
    !s.chars().any(|ch| ch.is_ascii_digit() && ch != '0')
}

/// "General Number": up to 15 significant digits, no grouping.
fn general_number(n: f64, c: &FormatCulture) -> String {
    if n == 0.0 {
        return "0".into();
    }
    // Round to 15 significant digits (VBA's General), then the shortest text.
    let rounded: f64 = format!("{:.14e}", n).parse().unwrap_or(n);
    let abs = rounded.abs();
    let text = if !(1e-15..1e15).contains(&abs) {
        // Scientific, as VBA writes it: 1E+15, 1.5E-16.
        let s = format!("{:e}", rounded);
        let (mantissa, exp) = s.split_once('e').unwrap_or((&s, "0"));
        let exp: i32 = exp.parse().unwrap_or(0);
        format!(
            "{}E{}{:02}",
            mantissa,
            if exp < 0 { "-" } else { "+" },
            exp.abs()
        )
    } else {
        format!("{}", rounded)
    };
    text.replace('.', &c.decimal_separator)
}

/// Pick the section of a `;`-separated custom number format and render it.
fn format_sections(n: f64, format: &str, c: &FormatCulture) -> String {
    let sections = split_sections(format);
    match sections.len() {
        0 => general_number(n, c),
        1 => {
            let body = custom_number(n.abs(), sections[0], c);
            if n < 0.0 && !is_all_zero(&body) {
                format!("-{body}")
            } else {
                body
            }
        }
        2 => {
            if n < 0.0 {
                custom_number(n.abs(), sections[1], c)
            } else {
                custom_number(n, sections[0], c)
            }
        }
        _ => {
            if n == 0.0 {
                custom_number(0.0, sections[2], c)
            } else if n < 0.0 {
                custom_number(n.abs(), sections[1], c)
            } else {
                custom_number(n, sections[0], c)
            }
        }
    }
}

/// Split on `;` outside quotes and escapes.
fn split_sections(format: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_quote = false;
    let mut escaped = false;
    for (i, ch) in format.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if !in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            ';' if !in_quote => {
                out.push(&format[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&format[start..]);
    out
}

#[derive(Debug, Clone, PartialEq)]
enum NumTok {
    /// A digit placeholder: `true` for `0`, `false` for `#`.
    Digit(bool),
    Point,
    Comma,
    Percent,
    /// `E+`/`E-` (sign always / minus only) followed by its digit count.
    Exponent {
        plus: bool,
        min_digits: usize,
    },
    Literal(String),
}

fn tokenize_number(section: &str) -> Vec<NumTok> {
    let chars: Vec<char> = section.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '0' => toks.push(NumTok::Digit(true)),
            '#' | '?' => toks.push(NumTok::Digit(false)),
            '.' => toks.push(NumTok::Point),
            ',' => toks.push(NumTok::Comma),
            '%' => toks.push(NumTok::Percent),
            'E' | 'e' if matches!(chars.get(i + 1), Some('+') | Some('-')) => {
                let plus = chars[i + 1] == '+';
                let mut j = i + 2;
                let mut min_digits = 0;
                while j < chars.len() && matches!(chars[j], '0' | '#') {
                    if chars[j] == '0' {
                        min_digits += 1;
                    }
                    j += 1;
                }
                toks.push(NumTok::Exponent {
                    plus,
                    min_digits: min_digits.max(1),
                });
                i = j;
                continue;
            }
            '\\' => {
                if let Some(next) = chars.get(i + 1) {
                    toks.push(NumTok::Literal(next.to_string()));
                    i += 2;
                    continue;
                }
            }
            '"' => {
                let mut j = i + 1;
                let mut lit = String::new();
                while j < chars.len() && chars[j] != '"' {
                    lit.push(chars[j]);
                    j += 1;
                }
                toks.push(NumTok::Literal(lit));
                i = j + 1;
                continue;
            }
            other => toks.push(NumTok::Literal(other.to_string())),
        }
        i += 1;
    }
    toks
}

/// Render a non-negative `n` with one custom number section.
fn custom_number(n: f64, section: &str, c: &FormatCulture) -> String {
    let toks = tokenize_number(section);
    let first_digit = toks
        .iter()
        .position(|t| matches!(t, NumTok::Digit(_) | NumTok::Point));
    let Some(first_digit) = first_digit else {
        // No placeholder at all: the section is literal text.
        return toks
            .iter()
            .map(|t| match t {
                NumTok::Literal(s) => s.clone(),
                NumTok::Percent => "%".into(),
                NumTok::Comma => ",".into(),
                _ => String::new(),
            })
            .collect();
    };
    let point = toks.iter().position(|t| matches!(t, NumTok::Point));
    let exponent = toks
        .iter()
        .position(|t| matches!(t, NumTok::Exponent { .. }));
    let number_end = exponent.unwrap_or(toks.len());
    let last_digit = toks[..number_end]
        .iter()
        .rposition(|t| matches!(t, NumTok::Digit(_) | NumTok::Point))
        .unwrap_or(first_digit);
    let int_end = point.unwrap_or(number_end);

    // Integer placeholders, fraction placeholders.
    let int_digits: Vec<bool> = toks[first_digit..int_end]
        .iter()
        .filter_map(|t| {
            if let NumTok::Digit(z) = t {
                Some(*z)
            } else {
                None
            }
        })
        .collect();
    let frac_digits: Vec<bool> = match point {
        Some(p) => toks[p + 1..=last_digit.max(p)]
            .iter()
            .filter_map(|t| {
                if let NumTok::Digit(z) = t {
                    Some(*z)
                } else {
                    None
                }
            })
            .collect(),
        None => Vec::new(),
    };
    // Grouping: a comma BETWEEN integer placeholders. Scaling: commas right
    // after the last integer placeholder (before the point, or at the end).
    let int_region = &toks[first_digit..int_end];
    let last_int_digit = int_region
        .iter()
        .rposition(|t| matches!(t, NumTok::Digit(_)));
    let grouping = match last_int_digit {
        Some(last) => int_region[..last]
            .iter()
            .any(|t| matches!(t, NumTok::Comma)),
        None => false,
    };
    // Scaling commas right before the point (with no point, the integer
    // region runs to the end, so this also counts the trailing ones)...
    let scale_before = match last_int_digit {
        Some(last) => int_region[last + 1..]
            .iter()
            .take_while(|t| matches!(t, NumTok::Comma))
            .count(),
        None => 0,
    };
    // ...and, with a point, the commas right after the last placeholder.
    let scale_after = if point.is_some() {
        toks[(last_digit + 1).min(number_end)..number_end]
            .iter()
            .take_while(|t| matches!(t, NumTok::Comma))
            .count()
    } else {
        0
    };
    let scale_commas = scale_before + scale_after;
    let percents = toks.iter().filter(|t| matches!(t, NumTok::Percent)).count();

    let mut value = n * 100f64.powi(percents as i32) / 1000f64.powi(scale_commas as i32);
    let mut exp_value: i32 = 0;
    if exponent.is_some() && value != 0.0 {
        let int_places = int_digits.len().max(1) as i32;
        exp_value = value.abs().log10().floor() as i32 - (int_places - 1);
        value /= 10f64.powi(exp_value);
        // Rounding can carry the mantissa to the next power.
        let max_frac = frac_digits.len();
        let r = round_to(value, max_frac);
        if r >= 10f64.powi(int_places) {
            value /= 10.0;
            exp_value += 1;
        }
    }

    let max_frac = frac_digits.len();
    let min_frac = frac_digits
        .iter()
        .rposition(|z| *z)
        .map(|i| i + 1)
        .unwrap_or(0);
    let rounded = round_to(value, max_frac);
    let fixed = format!("{:.*}", max_frac, rounded);
    let (int_text, frac_text) = match fixed.split_once('.') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (fixed.clone(), String::new()),
    };
    let mut frac_text = frac_text;
    while frac_text.len() > min_frac && frac_text.ends_with('0') {
        frac_text.pop();
    }
    // Leading zeros: pad to the placeholders from the first `0` on.
    let min_int = int_digits
        .iter()
        .position(|z| *z)
        .map(|i| int_digits.len() - i)
        .unwrap_or(0);
    let mut int_text = if int_text == "0" {
        String::new()
    } else {
        int_text
    };
    while int_text.len() < min_int {
        int_text.insert(0, '0');
    }
    if grouping {
        int_text = group(&int_text, &c.group_separator);
    }

    // Emit, walking the tokens: the integer digits at the first integer
    // placeholder, the fraction digits at the fraction placeholders.
    let mut out = String::new();
    let mut int_emitted = false;
    let mut frac_iter = frac_text.chars();
    for (idx, tok) in toks.iter().enumerate() {
        match tok {
            NumTok::Digit(_) if idx < int_end => {
                if !int_emitted {
                    out.push_str(&int_text);
                    int_emitted = true;
                }
            }
            NumTok::Digit(_) => {
                if let Some(d) = frac_iter.next() {
                    out.push(d);
                }
            }
            NumTok::Point => {
                if !int_emitted {
                    out.push_str(&int_text);
                    int_emitted = true;
                }
                out.push_str(&c.decimal_separator);
            }
            NumTok::Comma => {}
            NumTok::Percent => out.push('%'),
            NumTok::Exponent { plus, min_digits } => {
                let sign = if exp_value < 0 {
                    "-"
                } else if *plus {
                    "+"
                } else {
                    ""
                };
                out.push('E');
                out.push_str(sign);
                out.push_str(&format!("{:0width$}", exp_value.abs(), width = *min_digits));
            }
            NumTok::Literal(s) => out.push_str(s),
        }
    }
    out
}

fn round_to(v: f64, places: usize) -> f64 {
    let factor = 10f64.powi(places as i32);
    let scaled = v * factor;
    // Half away from zero, with a nudge for binary representation error
    // (2.675 is stored as 2.67499999...).
    let nudged = scaled + scaled.signum() * 1e-9 * scaled.abs().max(1.0).log10().max(1.0);
    nudged.round() / factor
}

fn group(digits: &str, sep: &str) -> String {
    let len = digits.len();
    let mut out = String::with_capacity(len + len / 3 * sep.len());
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push_str(sep);
        }
        out.push(ch);
    }
    out
}

/// Whether a custom pattern is a DATE/TIME pattern: it has a date or time
/// token outside quotes and escapes and no `0`/`#` digit placeholder.
fn is_date_pattern(format: &str) -> bool {
    let mut in_quote = false;
    let mut escaped = false;
    let mut has_date = false;
    for ch in format.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if !in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            _ if in_quote => {}
            '0' | '#' => return false,
            'd' | 'D' | 'm' | 'M' | 'y' | 'Y' | 'h' | 'H' | 'n' | 'N' | 's' | 'S' | 'q' | 'Q'
            | 'w' | 'W' | 't' | 'T' | 'c' | 'C' => has_date = true,
            _ => {}
        }
    }
    has_date
}

#[derive(Debug, Clone, PartialEq)]
enum DateTok {
    Day(usize),
    Month(usize),
    Minute(usize),
    Year(usize),
    Hour(usize),
    Second(usize),
    Quarter,
    Weekday(usize),
    /// AM/PM-style designator: (upper/lower/culture, one letter).
    AmPm {
        style: AmPmStyle,
    },
    GeneralDate,
    LongTime,
    DateSep,
    TimeSep,
    Literal(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum AmPmStyle {
    Upper,
    Lower,
    LetterUpper,
    LetterLower,
    Culture,
}

fn tokenize_date(pattern: &str) -> Vec<DateTok> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut toks: Vec<DateTok> = Vec::new();
    let mut i = 0;
    let run = |i: usize, target: char| -> usize {
        chars[i..]
            .iter()
            .take_while(|c| c.eq_ignore_ascii_case(&target))
            .count()
    };
    let starts_with_ci = |i: usize, s: &str| -> bool {
        let n = s.chars().count();
        i + n <= chars.len()
            && chars[i..i + n]
                .iter()
                .collect::<String>()
                .eq_ignore_ascii_case(s)
    };
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' {
            if let Some(next) = chars.get(i + 1) {
                toks.push(DateTok::Literal(next.to_string()));
            }
            i += 2;
            continue;
        }
        if ch == '"' || ch == '\'' {
            let mut j = i + 1;
            let mut lit = String::new();
            while j < chars.len() && chars[j] != ch {
                lit.push(chars[j]);
                j += 1;
            }
            toks.push(DateTok::Literal(lit));
            i = j + 1;
            continue;
        }
        if starts_with_ci(i, "am/pm") {
            let upper = chars[i].is_ascii_uppercase();
            toks.push(DateTok::AmPm {
                style: if upper {
                    AmPmStyle::Upper
                } else {
                    AmPmStyle::Lower
                },
            });
            i += 5;
            continue;
        }
        if starts_with_ci(i, "a/p") {
            let upper = chars[i].is_ascii_uppercase();
            toks.push(DateTok::AmPm {
                style: if upper {
                    AmPmStyle::LetterUpper
                } else {
                    AmPmStyle::LetterLower
                },
            });
            i += 3;
            continue;
        }
        if starts_with_ci(i, "ampm") {
            toks.push(DateTok::AmPm {
                style: AmPmStyle::Culture,
            });
            i += 4;
            continue;
        }
        match ch.to_ascii_lowercase() {
            'd' => {
                let n = run(i, 'd');
                toks.push(DateTok::Day(n));
                i += n;
            }
            'm' => {
                let n = run(i, 'm');
                toks.push(DateTok::Month(n));
                i += n;
            }
            'n' => {
                let n = run(i, 'n');
                toks.push(DateTok::Minute(n.min(2)));
                i += n;
            }
            'y' => {
                let n = run(i, 'y');
                toks.push(DateTok::Year(n));
                i += n;
            }
            'h' => {
                let n = run(i, 'h');
                toks.push(DateTok::Hour(n.min(2)));
                i += n;
            }
            's' => {
                let n = run(i, 's');
                toks.push(DateTok::Second(n.min(2)));
                i += n;
            }
            'q' => {
                toks.push(DateTok::Quarter);
                i += 1;
            }
            'w' => {
                let n = run(i, 'w');
                toks.push(DateTok::Weekday(n.min(2)));
                i += n;
            }
            't' => {
                let n = run(i, 't');
                if n >= 5 {
                    toks.push(DateTok::LongTime);
                } else {
                    // .NET's `tt` / `t`: the AM/PM designator.
                    toks.push(DateTok::AmPm {
                        style: AmPmStyle::Culture,
                    });
                }
                i += n;
            }
            'c' => {
                toks.push(DateTok::GeneralDate);
                i += 1;
            }
            '/' => {
                toks.push(DateTok::DateSep);
                i += 1;
            }
            ':' => {
                toks.push(DateTok::TimeSep);
                i += 1;
            }
            _ => {
                toks.push(DateTok::Literal(ch.to_string()));
                i += 1;
            }
        }
    }
    // `m`/`mm` right after an hour (literals and separators between) or right
    // before a second is the MINUTE.
    let is_sep =
        |t: &DateTok| matches!(t, DateTok::TimeSep | DateTok::DateSep | DateTok::Literal(_));
    for idx in 0..toks.len() {
        if let DateTok::Month(n) = toks[idx] {
            if n > 2 {
                continue;
            }
            let after_hour = toks[..idx]
                .iter()
                .rev()
                .find(|t| !is_sep(t))
                .is_some_and(|t| matches!(t, DateTok::Hour(_)));
            let before_second = toks[idx + 1..]
                .iter()
                .find(|t| !is_sep(t))
                .is_some_and(|t| matches!(t, DateTok::Second(_)));
            if after_hour || before_second {
                toks[idx] = DateTok::Minute(n);
            }
        }
    }
    toks
}

/// Render a custom (or culture) date/time pattern.
fn format_date_pattern(dt: &NaiveDateTime, pattern: &str, c: &FormatCulture) -> String {
    let toks = tokenize_date(pattern);
    let twelve_hour = toks.iter().any(|t| matches!(t, DateTok::AmPm { .. }));
    let mut out = String::new();
    let pm = dt.hour() >= 12;
    for tok in &toks {
        match tok {
            DateTok::Day(1) => out.push_str(&dt.day().to_string()),
            DateTok::Day(2) => out.push_str(&format!("{:02}", dt.day())),
            DateTok::Day(3) => {
                out.push_str(&c.days_short[dt.weekday().num_days_from_sunday() as usize])
            }
            DateTok::Day(4) => out.push_str(&c.days[dt.weekday().num_days_from_sunday() as usize]),
            DateTok::Day(5) => out.push_str(&format_date_pattern(dt, &c.short_date, c)),
            DateTok::Day(_) => out.push_str(&format_date_pattern(dt, &c.long_date, c)),
            DateTok::Month(1) => out.push_str(&dt.month().to_string()),
            DateTok::Month(2) => out.push_str(&format!("{:02}", dt.month())),
            DateTok::Month(3) => out.push_str(&c.months_short[dt.month0() as usize]),
            DateTok::Month(_) => out.push_str(&c.months[dt.month0() as usize]),
            DateTok::Minute(1) => out.push_str(&dt.minute().to_string()),
            DateTok::Minute(_) => out.push_str(&format!("{:02}", dt.minute())),
            DateTok::Second(1) => out.push_str(&dt.second().to_string()),
            DateTok::Second(_) => out.push_str(&format!("{:02}", dt.second())),
            DateTok::Hour(n) => {
                let h = if twelve_hour {
                    match dt.hour() % 12 {
                        0 => 12,
                        h => h,
                    }
                } else {
                    dt.hour()
                };
                if *n >= 2 {
                    out.push_str(&format!("{:02}", h));
                } else {
                    out.push_str(&h.to_string());
                }
            }
            DateTok::Year(1) => out.push_str(&dt.ordinal().to_string()),
            DateTok::Year(2) => out.push_str(&format!("{:02}", dt.year().rem_euclid(100))),
            DateTok::Year(_) => out.push_str(&format!("{:04}", dt.year())),
            DateTok::Quarter => out.push_str(&((dt.month0() / 3) + 1).to_string()),
            DateTok::Weekday(1) => {
                out.push_str(&(dt.weekday().num_days_from_sunday() + 1).to_string())
            }
            DateTok::Weekday(_) => {
                // Week of the year, the week holding January 1 being week 1
                // (VBA's default, vbSunday / vbFirstJan1).
                let jan1 = NaiveDate::from_ymd_opt(dt.year(), 1, 1).unwrap_or(dt.date());
                let offset = jan1.weekday().num_days_from_sunday();
                let week = (dt.ordinal0() + offset) / 7 + 1;
                out.push_str(&week.to_string());
            }
            DateTok::AmPm { style } => {
                let s = match style {
                    AmPmStyle::Upper => (if pm { "PM" } else { "AM" }).to_string(),
                    AmPmStyle::Lower => (if pm { "pm" } else { "am" }).to_string(),
                    AmPmStyle::LetterUpper => (if pm { "P" } else { "A" }).to_string(),
                    AmPmStyle::LetterLower => (if pm { "p" } else { "a" }).to_string(),
                    AmPmStyle::Culture => {
                        if pm {
                            c.pm_designator.clone()
                        } else {
                            c.am_designator.clone()
                        }
                    }
                };
                out.push_str(&s);
            }
            DateTok::GeneralDate => out.push_str(&general_date(dt, c)),
            DateTok::LongTime => out.push_str(&format_date_pattern(dt, &c.long_time, c)),
            DateTok::DateSep => out.push_str(&c.date_separator),
            DateTok::TimeSep => out.push_str(&c.time_separator),
            DateTok::Literal(s) => out.push_str(s),
        }
    }
    out
}

// ============================================================================
// The DataFusion UDF
// ============================================================================

/// The SQL name `FORMAT` compiles to.
pub const FORMAT_UDF_NAME: &str = "calcula_format";

/// `calcula_format(value, format)` in `culture`: any value type (numbers and
/// decimals, dates and timestamps, text, booleans, NULL -> ""), returning
/// Utf8.
pub fn format_udf(culture: FormatCulture) -> datafusion::logical_expr::ScalarUDF {
    datafusion::logical_expr::ScalarUDF::new_from_impl(FormatUdf {
        signature: datafusion::logical_expr::Signature::any(
            2,
            datafusion::logical_expr::Volatility::Immutable,
        ),
        culture,
    })
}

#[derive(Debug)]
struct FormatUdf {
    signature: datafusion::logical_expr::Signature,
    culture: FormatCulture,
}

impl datafusion::logical_expr::ScalarUDFImpl for FormatUdf {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn name(&self) -> &str {
        FORMAT_UDF_NAME
    }

    fn signature(&self) -> &datafusion::logical_expr::Signature {
        &self.signature
    }

    fn return_type(
        &self,
        _arg_types: &[arrow::datatypes::DataType],
    ) -> datafusion::error::Result<arrow::datatypes::DataType> {
        Ok(arrow::datatypes::DataType::Utf8)
    }

    fn invoke_batch(
        &self,
        args: &[datafusion::logical_expr::ColumnarValue],
        number_rows: usize,
    ) -> datafusion::error::Result<datafusion::logical_expr::ColumnarValue> {
        use arrow::array::{Array, ArrayRef, StringArray};
        use arrow::datatypes::{DataType, TimeUnit};
        if args.len() != 2 {
            return Err(datafusion::error::DataFusionError::Plan(
                "FORMAT takes a value and a format string".to_string(),
            ));
        }
        let arrays: Vec<ArrayRef> = args
            .iter()
            .map(|a| a.clone().into_array(number_rows))
            .collect::<datafusion::error::Result<_>>()?;
        let formats = arrow::compute::cast(&arrays[1], &DataType::Utf8)?;
        let formats = formats
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| {
                datafusion::error::DataFusionError::Internal("FORMAT: format cast".into())
            })?;
        let values = &arrays[0];
        let n = values.len();
        let mut out: Vec<String> = Vec::with_capacity(n);
        let fmt_at = |i: usize| {
            if formats.is_null(i) {
                ""
            } else {
                formats.value(i)
            }
        };
        match values.data_type() {
            DataType::Null => out.extend((0..n).map(|_| String::new())),
            DataType::Boolean => {
                let b = values
                    .as_any()
                    .downcast_ref::<arrow::array::BooleanArray>()
                    .ok_or_else(|| {
                        datafusion::error::DataFusionError::Internal("FORMAT: bool".into())
                    })?;
                for i in 0..n {
                    let v = if b.is_null(i) {
                        FormatValue::Blank
                    } else {
                        FormatValue::Bool(b.value(i))
                    };
                    out.push(format_value(&v, fmt_at(i), &self.culture));
                }
            }
            DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _) => {
                let ts = arrow::compute::cast(
                    values,
                    &DataType::Timestamp(TimeUnit::Millisecond, None),
                )?;
                let ts = ts
                    .as_any()
                    .downcast_ref::<arrow::array::TimestampMillisecondArray>()
                    .ok_or_else(|| {
                        datafusion::error::DataFusionError::Internal("FORMAT: timestamp".into())
                    })?;
                for i in 0..n {
                    let v = if ts.is_null(i) {
                        FormatValue::Blank
                    } else {
                        match chrono::DateTime::from_timestamp_millis(ts.value(i)) {
                            Some(dt) => FormatValue::DateTime(dt.naive_utc()),
                            None => FormatValue::Blank,
                        }
                    };
                    out.push(format_value(&v, fmt_at(i), &self.culture));
                }
            }
            DataType::Utf8
            | DataType::LargeUtf8
            | DataType::Utf8View
            | DataType::Dictionary(_, _) => {
                let s = arrow::compute::cast(values, &DataType::Utf8)?;
                let s = s.as_any().downcast_ref::<StringArray>().ok_or_else(|| {
                    datafusion::error::DataFusionError::Internal("FORMAT: text".into())
                })?;
                for i in 0..n {
                    let v = if s.is_null(i) {
                        FormatValue::Blank
                    } else {
                        FormatValue::Text(s.value(i).to_string())
                    };
                    out.push(format_value(&v, fmt_at(i), &self.culture));
                }
            }
            _ => {
                let f = arrow::compute::cast(values, &DataType::Float64)?;
                let f = f
                    .as_any()
                    .downcast_ref::<arrow::array::Float64Array>()
                    .ok_or_else(|| {
                        datafusion::error::DataFusionError::Internal("FORMAT: number".into())
                    })?;
                for i in 0..n {
                    let v = if f.is_null(i) {
                        FormatValue::Blank
                    } else {
                        FormatValue::Number(f.value(i))
                    };
                    out.push(format_value(&v, fmt_at(i), &self.culture));
                }
            }
        }
        let array: ArrayRef = std::sync::Arc::new(StringArray::from(out));
        if args
            .iter()
            .all(|a| matches!(a, datafusion::logical_expr::ColumnarValue::Scalar(_)))
        {
            let scalar = datafusion::scalar::ScalarValue::try_from_array(&array, 0)?;
            return Ok(datafusion::logical_expr::ColumnarValue::Scalar(scalar));
        }
        Ok(datafusion::logical_expr::ColumnarValue::Array(array))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn en() -> FormatCulture {
        FormatCulture::en_us()
    }
    fn sv() -> FormatCulture {
        FormatCulture::sv_se()
    }
    fn num(n: f64, f: &str, c: &FormatCulture) -> String {
        format_value(&FormatValue::Number(n), f, c)
    }
    fn date(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> FormatValue {
        FormatValue::DateTime(
            NaiveDate::from_ymd_opt(y, m, d)
                .unwrap()
                .and_hms_opt(h, mi, s)
                .unwrap(),
        )
    }
    fn dt(v: &FormatValue, f: &str, c: &FormatCulture) -> String {
        format_value(v, f, c)
    }
    const NB: &str = "\u{a0}";

    #[test]
    fn custom_numbers_in_en_us() {
        assert_eq!(num(1234.5, "#,0.00", &en()), "1,234.50");
        assert_eq!(num(1234.5, "#,##0", &en()), "1,235");
        assert_eq!(num(1234567.891, "#,##0.00", &en()), "1,234,567.89");
        assert_eq!(num(0.5, "0.0", &en()), "0.5");
        assert_eq!(num(0.5, "#.00", &en()), ".50");
        assert_eq!(num(1.0, "#.##", &en()), "1.");
        assert_eq!(num(5.0, "000", &en()), "005");
        assert_eq!(num(-1234.5, "#,0.00", &en()), "-1,234.50");
        assert_eq!(num(-1234.5, "#,0.00;(#,0.00)", &en()), "(1,234.50)");
        assert_eq!(num(0.0, "#,0.00;(#,0.00);\"zero\"", &en()), "zero");
        assert_eq!(num(0.1234, "0.0%", &en()), "12.3%");
        assert_eq!(num(1234.5, "$#,##0.00", &en()), "$1,234.50");
        assert_eq!(num(1234567.0, "#,##0,", &en()), "1,235");
        assert_eq!(num(1234567.0, "0.0,,", &en()), "1.2");
        assert_eq!(num(1234.5, "0.00E+00", &en()), "1.23E+03");
        assert_eq!(num(0.000123, "0.0E-0", &en()), "1.2E-4");
        assert_eq!(num(2.675, "0.00", &en()), "2.68");
        assert_eq!(num(-0.001, "0.00", &en()), "0.00");
    }

    #[test]
    fn custom_numbers_in_sv_se_use_the_cultures_separators() {
        assert_eq!(num(1234.5, "#,0.00", &sv()), format!("1{NB}234,50"));
        assert_eq!(
            num(1234567.891, "#,##0.00", &sv()),
            format!("1{NB}234{NB}567,89")
        );
        assert_eq!(num(0.1234, "0.0%", &sv()), "12,3%");
        assert_eq!(num(1234.5, "0.00E+00", &sv()), "1,23E+03");
    }

    #[test]
    fn named_number_formats() {
        assert_eq!(num(1234.5, "General Number", &en()), "1234.5");
        assert_eq!(num(1234.5, "General Number", &sv()), "1234,5");
        assert_eq!(num(1234.5, "Currency", &en()), "$1,234.50");
        assert_eq!(num(-1234.5, "Currency", &en()), "-$1,234.50");
        assert_eq!(num(1234.5, "Currency", &sv()), format!("1{NB}234,50{NB}kr"));
        assert_eq!(num(1234.5, "Fixed", &en()), "1234.50");
        assert_eq!(num(1234.5, "Fixed", &sv()), "1234,50");
        assert_eq!(num(1234.5, "Standard", &en()), "1,234.50");
        assert_eq!(num(1234.5, "Standard", &sv()), format!("1{NB}234,50"));
        assert_eq!(num(0.1234, "Percent", &en()), "12.34%");
        assert_eq!(num(0.1234, "Percent", &sv()), "12,34%");
        assert_eq!(num(1234.5, "Scientific", &en()), "1.23E+03");
        assert_eq!(num(0.0, "Yes/No", &en()), "No");
        assert_eq!(num(3.0, "True/False", &en()), "True");
        assert_eq!(num(1.0, "On/Off", &en()), "On");
        assert_eq!(num(1234.5, "", &en()), "1234.5");
        assert_eq!(num(0.1 + 0.2, "", &en()), "0.3");
    }

    #[test]
    fn dates_in_en_us() {
        let v = date(2024, 1, 15, 14, 30, 5);
        assert_eq!(dt(&v, "yyyy-mm-dd", &en()), "2024-01-15");
        assert_eq!(dt(&v, "yyyy-MM-dd HH:mm:ss", &en()), "2024-01-15 14:30:05");
        assert_eq!(dt(&v, "dd/mm/yyyy", &en()), "15/01/2024");
        assert_eq!(dt(&v, "mmmm yyyy", &en()), "January 2024");
        assert_eq!(dt(&v, "mmm d, yyyy", &en()), "Jan 15, 2024");
        assert_eq!(dt(&v, "dddd", &en()), "Monday");
        assert_eq!(dt(&v, "ddd", &en()), "Mon");
        assert_eq!(dt(&v, "h:nn AM/PM", &en()), "2:30 PM");
        assert_eq!(dt(&v, "hh:mm:ss", &en()), "14:30:05");
        assert_eq!(dt(&v, "\"Q\"q yyyy", &en()), "Q1 2024");
        assert_eq!(dt(&v, "Short Date", &en()), "1/15/2024");
        assert_eq!(dt(&v, "Long Date", &en()), "Monday, January 15, 2024");
        assert_eq!(dt(&v, "Medium Date", &en()), "15-Jan-24");
        assert_eq!(dt(&v, "Long Time", &en()), "2:30:05 PM");
        assert_eq!(dt(&v, "Medium Time", &en()), "02:30 PM");
        assert_eq!(dt(&v, "Short Time", &en()), "14:30");
        assert_eq!(dt(&v, "General Date", &en()), "1/15/2024 2:30:05 PM");
        assert_eq!(
            dt(&date(2024, 1, 15, 0, 0, 0), "General Date", &en()),
            "1/15/2024"
        );
        assert_eq!(dt(&date(2024, 1, 15, 0, 0, 0), "", &en()), "1/15/2024");
    }

    #[test]
    fn dates_in_sv_se_use_the_cultures_names_and_separators() {
        let v = date(2024, 1, 15, 14, 30, 5);
        assert_eq!(dt(&v, "yyyy-mm-dd", &sv()), "2024-01-15");
        assert_eq!(dt(&v, "dd/mm/yyyy", &sv()), "15-01-2024");
        assert_eq!(dt(&v, "mmmm yyyy", &sv()), "januari 2024");
        assert_eq!(dt(&v, "dddd", &sv()), "m\u{e5}ndag");
        assert_eq!(dt(&v, "Short Date", &sv()), "2024-01-15");
        assert_eq!(dt(&v, "Long Date", &sv()), "den 15 januari 2024");
        assert_eq!(dt(&v, "Long Time", &sv()), "14:30:05");
        assert_eq!(dt(&v, "General Date", &sv()), "2024-01-15 14:30:05");
        assert_eq!(dt(&v, "h:nn AM/PM", &sv()), "2:30 PM");
        assert_eq!(dt(&v, "h:nn ampm", &sv()), "2:30 em");
    }

    #[test]
    fn de_de_and_the_builtin_lookup() {
        let de = FormatCulture::builtin("de_DE").expect("de-DE is built in");
        assert_eq!(num(1234.5, "#,0.00", &de), "1.234,50");
        assert_eq!(
            num(1234.5, "Currency", &de),
            format!("1.234,50{NB}\u{20ac}")
        );
        let v = date(2024, 1, 15, 14, 30, 5);
        assert_eq!(dt(&v, "dd/mm/yyyy", &de), "15.01.2024");
        assert_eq!(dt(&v, "Long Date", &de), "Montag, 15. Januar 2024");
        assert_eq!(FormatCulture::builtin("EN-us"), Some(en()));
        assert_eq!(FormatCulture::builtin("fr-FR"), None);
        assert_ne!(en().identity(), sv().identity());
    }

    #[test]
    fn serials_and_dates_cross_over() {
        // 45306 = 2024-01-15.
        assert_eq!(num(45306.0, "yyyy-mm-dd", &en()), "2024-01-15");
        assert_eq!(num(45306.5, "Short Time", &en()), "12:00");
        assert_eq!(dt(&date(2024, 1, 15, 12, 0, 0), "0.0", &en()), "45306.5");
    }

    #[test]
    fn blank_text_and_booleans() {
        assert_eq!(format_value(&FormatValue::Blank, "#,0.00", &en()), "");
        assert_eq!(
            format_value(&FormatValue::Text("abc".into()), "0.00", &en()),
            "abc"
        );
        assert_eq!(
            format_value(&FormatValue::Bool(true), "Yes/No", &en()),
            "Yes"
        );
        assert_eq!(format_value(&FormatValue::Bool(false), "", &en()), "False");
    }
}
