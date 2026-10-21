//! FILENAME: core/engine/src/member_label.rs
//! PURPOSE: Write the LABEL of a member (a pivot item, a BI column value, a
//!          slicer item) for a locale from its invariant KEY and a description
//!          of what the key is -- without ever re-parsing display text.
//!
//! ## Key and label are two different things
//!
//! A member has ONE identity: its KEY, the invariant canonical text the engine
//! interns ("2013", "1234.5", "2024-01-15", "Jan", "Q3", "10-19"). Selections,
//! filters, page filters, GETPIVOTDATA and cross-filter tuples match on it, and
//! it never changes with the app locale (the BUG-0166 precedent: a key that
//! followed the display language silently stopped matching the moment the user
//! switched it).
//!
//! The LABEL is what a person reads: the same member written for the app
//! locale ("1234,5", "15.01.2024", "jan", "Kv3"). It is computed at RESPONSE
//! time from the key plus a [`MemberSource`], which is locale-free and so can
//! be cached, snapshotted for undo and sent over the wire without going stale
//! when the locale changes.
//!
//! THE RULE THIS MODULE EXISTS TO ENFORCE: a label is never parsed back into a
//! key, and a key is never derived from a label. `member_label` takes the key
//! by reference and returns a NEW string; nothing in here can alter the key.
//!
//! ## What stays English, by decision
//!
//! "(Blank)" and TRUE/FALSE are prose, and prose stays English this round (the
//! AI-programme decision at `core/insights/src/narrate/mod.rs`). Only month,
//! day and quarter NAMES and the digits/separators localise.

use serde::{Deserialize, Serialize};

use crate::locale::LocaleSettings;
use crate::number_format::format_number;
use crate::style::NumberFormat;

/// The label of a blank member. Power BI's "(Blank)" (orchestrator ruling Q8,
/// 2026-10-16): the blank member's KEY is "" everywhere, and this is its label.
pub const BLANK_MEMBER_LABEL: &str = "(Blank)";

/// What a member KEY is, so its LABEL can be written for a locale without
/// re-parsing display text. Locale-free; carried on pivot view cells.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MemberSource {
    /// label = key (also the date-group Week key "W01").
    Text,
    /// General, app separators (also Year, Day and single-width bins).
    Number { value: f64 },
    /// `locale.date_format`.
    Date { serial: f64 },
    /// `date_format` + " " + `time_format`.
    DateTime { serial: f64 },
    /// `locale.calendar().month_short(month)`.
    Month { month: u32 },
    /// `locale.calendar().quarter_label(quarter)`.
    Quarter { quarter: u32 },
    /// "a-b" with app separators. `end` is the bin's EXCLUSIVE end, exactly as
    /// the pivot engine's binning stores it: an integer bin [10, 20) reads
    /// "10-19"; a fractional one reads "10,00-20,00" (two decimals).
    NumberBin { start: f64, end: f64, integer: bool },
    /// "<" + General(start): the under-range overflow bin.
    BinBelow { start: f64 },
    /// ">" + General(end): the over-range overflow bin.
    BinAbove { end: f64 },
    /// "(Blank)" (English by decision).
    Blank,
    /// "TRUE"/"FALSE" (unchanged; English by decision).
    Boolean { value: bool },
    /// label = key ("#N/A").
    Error,
}

/// General number text in the locale's decimal separator. General has no
/// grouping, so "2013" is "2013" in every locale.
fn general(value: f64, locale: &LocaleSettings) -> String {
    format_number(value, &NumberFormat::General, locale)
}

/// The app-locale LABEL of the member whose invariant KEY is `key`.
///
/// `key` is only read for the sources whose label IS the key (`Text`,
/// `Error`); every other source carries the typed value it is written from, so
/// no display text is ever parsed here.
pub fn member_label(key: &str, source: &MemberSource, locale: &LocaleSettings) -> String {
    match source {
        MemberSource::Text | MemberSource::Error => key.to_string(),
        MemberSource::Number { value } => general(*value, locale),
        MemberSource::Date { serial } => format_number(
            *serial,
            &NumberFormat::Date { format: locale.date_format.clone() },
            locale,
        ),
        MemberSource::DateTime { serial } => format_number(
            *serial,
            &NumberFormat::Date {
                format: format!("{} {}", locale.date_format, locale.time_format),
            },
            locale,
        ),
        MemberSource::Month { month } => locale.calendar().month_short(*month).to_string(),
        MemberSource::Quarter { quarter } => locale.calendar().quarter_label(*quarter),
        MemberSource::NumberBin { start, end, integer } => {
            if *integer {
                // The pivot engine's own spelling: inclusive end = end - 1.
                format!("{}-{}", general(*start, locale), general(*end - 1.0, locale))
            } else {
                let two = NumberFormat::Number {
                    decimal_places: 2,
                    use_thousands_separator: false,
                };
                format!(
                    "{}-{}",
                    format_number(*start, &two, locale),
                    format_number(*end, &two, locale)
                )
            }
        }
        MemberSource::BinBelow { start } => format!("<{}", general(*start, locale)),
        MemberSource::BinAbove { end } => format!(">{}", general(*end, locale)),
        MemberSource::Blank => BLANK_MEMBER_LABEL.to_string(),
        MemberSource::Boolean { value } => {
            if *value { "TRUE".to_string() } else { "FALSE".to_string() }
        }
    }
}

/// Parse exactly `n` ASCII digits.
fn digits(text: &str, n: usize) -> Option<u32> {
    if text.len() != n || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok()
}

/// Arrow-free helper for ISO keys written by the BI path ("2024-01-15",
/// "2024-01-15 13:04:05" -- `arrow_value_to_string`'s `%Y-%m-%d` and
/// `%Y-%m-%d %H:%M:%S`): `Some(Date)` / `Some(DateTime)`, or `None` for any
/// other text, an impossible calendar day, or a year Excel cannot hold
/// (before 1900 or after 9999). STRICT on purpose: it is only consulted for
/// columns the source DECLARED as dates, and a lenient reading would turn a
/// text code into a date.
pub fn iso_member_source(key: &str) -> Option<MemberSource> {
    let (date_text, time_text) = match key.len() {
        10 => (key, None),
        19 => {
            let sep = key.as_bytes()[10];
            if sep != b' ' && sep != b'T' {
                return None;
            }
            (&key[..10], Some(&key[11..]))
        }
        _ => return None,
    };
    let b = date_text.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year = digits(&date_text[0..4], 4)? as i32;
    let month = digits(&date_text[5..7], 2)?;
    let day = digits(&date_text[8..10], 2)?;
    if !(1900..=9999).contains(&year) || !(1..=12).contains(&month) || day < 1 {
        return None;
    }
    let max_day = if year == 1900 && month == 2 {
        29 // Excel's phantom 1900-02-29, as typed entry accepts it.
    } else {
        crate::date_serial::days_in_month(year, month)
    };
    if day > max_day {
        return None;
    }
    let serial = crate::date_serial::date_to_serial(year, month as i32, day as i32);
    match time_text {
        None => Some(MemberSource::Date { serial }),
        Some(t) => {
            let tb = t.as_bytes();
            if tb.len() != 8 || tb[2] != b':' || tb[5] != b':' {
                return None;
            }
            let h = digits(&t[0..2], 2)?;
            let m = digits(&t[3..5], 2)?;
            let s = digits(&t[6..8], 2)?;
            if h > 23 || m > 59 || s > 59 {
                return None;
            }
            let fraction = (h as f64 * 3600.0 + m as f64 * 60.0 + s as f64) / 86400.0;
            Some(MemberSource::DateTime { serial: serial + fraction })
        }
    }
}
