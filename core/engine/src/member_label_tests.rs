//! FILENAME: core/engine/src/member_label_tests.rs
//! PURPOSE: Pin `member_label` -- the app-locale LABEL of a member written from
//!          its invariant KEY plus a locale-free `MemberSource` -- and the two
//!          properties the whole key/label split rests on: the KEY is never
//!          altered by writing a label, and a label General prints exactly
//!          parses back, in the same locale, to the number it was written from.

use crate::locale::LocaleSettings;
use crate::member_label::{iso_member_source, member_label, MemberSource, BLANK_MEMBER_LABEL};
use crate::typed_entry::parse_number;

fn de() -> LocaleSettings {
    LocaleSettings::from_locale_id("de-DE")
}
fn sv() -> LocaleSettings {
    LocaleSettings::from_locale_id("sv-SE")
}
fn us() -> LocaleSettings {
    LocaleSettings::invariant()
}

#[test]
fn a_number_member_takes_the_locale_decimal_and_no_grouping() {
    let src = MemberSource::Number { value: 1234.5 };
    assert_eq!(member_label("1234.5", &src, &de()), "1234,5");
    assert_eq!(member_label("1234.5", &src, &sv()), "1234,5");
    assert_eq!(member_label("1234.5", &src, &us()), "1234.5");
}

#[test]
fn a_year_is_four_digits_in_every_locale() {
    let src = MemberSource::Number { value: 2013.0 };
    for (id, _) in LocaleSettings::supported_locales() {
        let locale = LocaleSettings::from_locale_id(&id);
        assert_eq!(member_label("2013", &src, &locale), "2013", "{id}");
    }
}

#[test]
fn month_and_quarter_members_use_the_calendar_names() {
    assert_eq!(member_label("Jan", &MemberSource::Month { month: 1 }, &sv()), "jan");
    assert_eq!(member_label("Jan", &MemberSource::Month { month: 1 }, &us()), "Jan");
    assert_eq!(member_label("Okt", &MemberSource::Month { month: 10 }, &sv()), "okt");
    assert_eq!(member_label("Q3", &MemberSource::Quarter { quarter: 3 }, &sv()), "Kv3");
    assert_eq!(member_label("Q3", &MemberSource::Quarter { quarter: 3 }, &us()), "Q3");
}

#[test]
fn number_bins_follow_the_pivot_engines_spelling_in_the_locale() {
    // A fractional bin: two decimals, the locale decimal, no grouping.
    let bin = MemberSource::NumberBin { start: 10.0, end: 20.0, integer: false };
    assert_eq!(member_label("10.00-20.00", &bin, &de()), "10,00-20,00");
    assert_eq!(member_label("10.00-20.00", &bin, &us()), "10.00-20.00");
    // An integer bin shows its INCLUSIVE end (end - 1), negatives included.
    let neg = MemberSource::NumberBin { start: -10.0, end: -5.0, integer: true };
    assert_eq!(member_label("-10--6", &neg, &de()), "-10--6");
    let pos = MemberSource::NumberBin { start: 10.0, end: 20.0, integer: true };
    assert_eq!(member_label("10-19", &pos, &us()), "10-19");
    // Overflow bins.
    assert_eq!(member_label("<0.5", &MemberSource::BinBelow { start: 0.5 }, &de()), "<0,5");
    assert_eq!(member_label(">100", &MemberSource::BinAbove { end: 100.0 }, &de()), ">100");
}

#[test]
fn date_members_use_the_locale_short_date() {
    let src = MemberSource::Date { serial: 45306.0 };
    assert_eq!(member_label("2024-01-15", &src, &de()), "15.01.2024");
    assert_eq!(member_label("2024-01-15", &src, &sv()), "2024-01-15");
    assert_eq!(member_label("2024-01-15", &src, &us()), "01/15/2024");
    let dt = iso_member_source("2024-01-15 13:04:05").expect("a datetime key");
    assert_eq!(member_label("2024-01-15 13:04:05", &dt, &sv()), "2024-01-15 13:04:05");
    assert_eq!(member_label("2024-01-15 13:04:05", &dt, &de()), "15.01.2024 13:04:05");
}

#[test]
fn text_error_blank_and_boolean_labels() {
    assert_eq!(member_label("W01", &MemberSource::Text, &sv()), "W01");
    assert_eq!(member_label("#N/A", &MemberSource::Error, &de()), "#N/A");
    assert_eq!(member_label("", &MemberSource::Blank, &de()), BLANK_MEMBER_LABEL);
    assert_eq!(BLANK_MEMBER_LABEL, "(Blank)");
    assert_eq!(member_label("TRUE", &MemberSource::Boolean { value: true }, &sv()), "TRUE");
    assert_eq!(member_label("FALSE", &MemberSource::Boolean { value: false }, &de()), "FALSE");
}

#[test]
fn iso_member_source_is_strict() {
    assert_eq!(iso_member_source("2024-01-15"), Some(MemberSource::Date { serial: 45306.0 }));
    match iso_member_source("2024-01-15 13:04:05") {
        Some(MemberSource::DateTime { serial }) => {
            let expected = 45306.0 + (13.0 * 3600.0 + 4.0 * 60.0 + 5.0) / 86400.0;
            assert!((serial - expected).abs() < 1e-12, "{serial}");
        }
        other => panic!("expected DateTime, got {other:?}"),
    }
    assert!(matches!(iso_member_source("2024-01-15T00:00:00"), Some(MemberSource::DateTime { .. })));
    // Excel's phantom day is a real member date.
    assert_eq!(iso_member_source("1900-02-29"), Some(MemberSource::Date { serial: 60.0 }));
    for bad in [
        "", "00123", "2024-1-15", "2024/01/15", "2024-02-30", "2024-13-01", "1899-12-31",
        "2024-01-15 25:00:00", "2024-01-15 13:04", "2024-01-15x13:04:05", "abcd-ef-gh",
        "15.01.2024",
    ] {
        assert_eq!(iso_member_source(bad), None, "{bad:?} must not be a date member");
    }
}

#[test]
fn member_source_round_trips_through_serde_with_a_kind_tag() {
    let src = MemberSource::NumberBin { start: 1.5, end: 3.0, integer: false };
    let json = serde_json::to_string(&src).unwrap();
    assert_eq!(json, r#"{"kind":"numberBin","start":1.5,"end":3.0,"integer":false}"#);
    let back: MemberSource = serde_json::from_str(&json).unwrap();
    assert_eq!(back, src);
    assert_eq!(serde_json::to_string(&MemberSource::Blank).unwrap(), r#"{"kind":"blank"}"#);
}

/// A tiny deterministic generator, so the property test needs no new crate
/// and a failure reproduces exactly.
struct Lcg(u64);
impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
}

#[test]
fn the_key_is_never_altered_and_the_label_is_stable() {
    let mut rng = Lcg(0x5EED_CA1C_u64);
    let locales = [us(), de(), sv(), LocaleSettings::from_locale_id("fr-FR")];
    for i in 0..200 {
        let bits = rng.next_u64();
        // A mix of integers, decimals and extreme magnitudes, both signs.
        let v = match i % 4 {
            0 => (bits % 1_000_000_000) as f64 - 500_000_000.0,
            1 => ((bits % 10_000_000_000) as f64 - 5e9) / 1e6,
            2 => f64::from_bits(bits & 0x7FEF_FFFF_FFFF_FFFF), // any finite positive
            _ => -(((bits % 1_000_000) as f64) * 1e-7),
        };
        assert!(v.is_finite());
        let key = format!("{}", v);
        let src = MemberSource::Number { value: v };
        for locale in &locales {
            let first = member_label(&key, &src, locale);
            let second = member_label(&key, &src, locale);
            // The key the caller passed is untouched and still spells v.
            assert_eq!(key, format!("{}", v), "key altered for {v}");
            assert_eq!(first, second, "unstable label for {v} in {}", locale.locale_id);
        }
    }
}

#[test]
fn a_general_label_parses_back_to_its_value_in_the_same_locale() {
    let mut rng = Lcg(0xDEC1_3A11_u64);
    let locales = [us(), de(), sv(), LocaleSettings::from_locale_id("fr-FR"), LocaleSettings::from_locale_id("de-CH")];
    let mut checked = 0;
    for i in 0..200 {
        let bits = rng.next_u64();
        let negative = bits & 1 == 1;
        // Values General prints EXACTLY: integers below 1e15, and decimals with
        // at most 6 fraction digits and a magnitude of at least 1e-4.
        let magnitude = if i % 2 == 0 {
            (bits % 999_999_999_999_999) as f64
        } else {
            (bits % 999_999_999_999) as f64 / 1e6
        };
        if magnitude != 0.0 && magnitude < 1e-4 {
            continue;
        }
        let v = if negative { -magnitude } else { magnitude };
        let src = MemberSource::Number { value: v };
        for locale in &locales {
            let label = member_label(&format!("{}", v), &src, locale);
            assert_eq!(
                parse_number(&label, locale),
                Some(v),
                "{v} labelled {label:?} in {} does not parse back",
                locale.locale_id
            );
        }
        checked += 1;
    }
    assert!(checked >= 190, "only {checked} values exercised");
}
