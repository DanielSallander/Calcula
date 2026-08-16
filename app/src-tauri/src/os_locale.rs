//! FILENAME: app/src-tauri/src/os_locale.rs
//! PURPOSE: Read Windows' actual REGIONAL SETTINGS and express them as an
//!          `engine::LocaleSettings`, so the `"system"` locale path shows the
//!          user what Excel on the same machine would show.
//! CONTEXT:  open-items 1.3. Calcula used a fixed per-locale-id table for every
//!           path including `"system"`. Excel reads `GetLocaleInfoEx`
//!           (`LOCALE_SSHORTDATE`, `SLONGDATE`, `STIMEFORMAT`, `SCURRENCY`, …),
//!           so a user who customises their short date to `dd-MMM-yy` sees that
//!           in Excel and did not see it here. The table stays: it is the base
//!           this overwrites onto, the fallback when a read fails, and the whole
//!           answer for an EXPLICIT locale override (`set_locale("de-DE")`).
//!
//! WHY IT LIVES IN THE APP CRATE. `core/engine` is a pure library — its
//! manifest lists `serde`, `rustc-hash`, `parser` and `identity` and nothing
//! else — and it is linked by the `.cala`/`.calp` format crates, which have no
//! business knowing what machine they are on. `app/src-tauri` is the
//! Windows-native layer that already owns three Credential Manager modules; it
//! is the only crate that both links `windows` and depends on `engine`.
//!
//! TWO DEFECTS THIS ALSO CLOSES, both measured rather than reasoned about:
//!
//!  1. `sys_locale::get_locale()` is `GetUserPreferredUILanguages` — the
//!     Windows DISPLAY LANGUAGE, not the regional format. They are independent
//!     settings, and an English-display machine with a Swedish region (a common
//!     configuration) got `en-US`: `.` decimals and `,` formula separators,
//!     while Excel beside it used `,` and `;`.
//!  2. `set_locale("system")` silently returned en-US. `from_locale_id("system")`
//!     matched no arm, and `"system".split('-').next()` is `"system"` again, so
//!     the language-fallback recursion could not fire and it landed on
//!     `invariant()`. Only `locale.ts` avoided ever sending that string.
//!
//! NOT READ, and named rather than left to be discovered: `LOCALE_SGROUPING`
//! (the `3;0` vs `3;2` digit-grouping rule) is ignored because
//! `add_thousands_separator` hard-codes groups of three, so Indian locales are
//! equally wrong before and after; and `LOCALE_INEGCURR` is ignored because the
//! negative-currency choice is modelled per FORMAT (`NegativeStyle`), not per
//! locale — see open-items 1.1.

use engine::{LocaleCurrencyPosition, LocaleSettings};

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Globalization::{
    GetLocaleInfoEx, LOCALE_ICURRENCY, LOCALE_SCURRENCY, LOCALE_SDECIMAL, LOCALE_SLIST,
    LOCALE_SLONGDATE, LOCALE_SNAME, LOCALE_SNATIVEDISPLAYNAME, LOCALE_SSHORTDATE,
    LOCALE_STHOUSAND, LOCALE_STIMEFORMAT,
};

/// The user's regional settings as a `LocaleSettings`.
///
/// STARTS FROM THE TABLE AND OVERWRITES WHAT THE OS ANSWERS FOR. Four
/// properties follow from that shape, each load-bearing:
///
///  * `engine::LocaleSettings` needs no new field — `char` separators and
///    `String` patterns already express everything `GetLocaleInfoEx` returns.
///  * Every read degrades PER FIELD. `GetLocaleInfoEx` returning 0 for one
///    `LCTYPE` leaves that one field on a sane default instead of abandoning
///    the whole read.
///  * `calendar()` keeps working: it dispatches month/weekday names on the
///    LANGUAGE part of `locale_id`, and seeding from `from_locale_id(SNAME)`
///    means `sv-SE` still resolves the Swedish names.
///  * It cannot panic. `create_app_state()` calls this, and that runs inside the
///    app-lib unit-test binary — a `.unwrap()` here would fail the suite on any
///    machine whose Windows disagreed with this file's assumptions.
pub fn system_locale_settings() -> LocaleSettings {
    #[cfg(windows)]
    {
        read_windows_locale()
    }
    #[cfg(not(windows))]
    {
        // Calcula is a Windows application; this arm exists so the module
        // compiles under a cross-check rather than as a supported path.
        LocaleSettings::invariant()
    }
}

#[cfg(windows)]
fn read_windows_locale() -> LocaleSettings {
    // `LOCALE_NAME_USER_DEFAULT` is `NULL` in `winnls.h` and is therefore not
    // exported by windows-rs at all. A null `lpLocaleName` IS that constant, so
    // one null pointer serves every read and there is no second notion of
    // "which locale" to keep in step.
    let id = read_str(LOCALE_SNAME).unwrap_or_default();
    let mut settings = LocaleSettings::from_locale_id(&id);
    if !id.is_empty() {
        settings.locale_id = id;
    }
    if let Some(name) = read_str(LOCALE_SNATIVEDISPLAYNAME) {
        settings.display_name = name;
    }
    if let Some(c) = read_char(LOCALE_SDECIMAL) {
        settings.decimal_separator = c;
    }
    if let Some(c) = read_char(LOCALE_STHOUSAND) {
        settings.thousands_separator = c;
    }
    if let Some(c) = read_char(LOCALE_SLIST) {
        settings.list_separator = c;
    }
    if let Some(p) = read_str(LOCALE_SSHORTDATE) {
        settings.date_format = win_pattern_to_excel(&p);
    }
    if let Some(p) = read_str(LOCALE_SLONGDATE) {
        settings.long_date_format = win_pattern_to_excel(&p);
    }
    if let Some(p) = read_str(LOCALE_STIMEFORMAT) {
        settings.time_format = win_pattern_to_excel(&p);
    }
    if let Some(symbol) = read_str(LOCALE_SCURRENCY) {
        // The position lives in a SEPARATE value; without both, a suffix
        // currency would be rendered as a prefix one.
        let mode = read_str(LOCALE_ICURRENCY)
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        let (sym, pos) = currency_shape(&symbol, mode);
        settings.currency_symbol = sym;
        settings.currency_position = pos;
    }
    settings
}

/// One `GetLocaleInfoEx` read as a `String`, or `None` if Windows refused.
///
/// `LOCALE_NOUSEROVERRIDE` is DELIBERATELY NOT SET. It would return the
/// system default for the locale and discard the user's Control Panel
/// customisations — which are precisely the customisations this module exists
/// to honour. Setting it turns the OS read back into a table with extra steps.
#[cfg(windows)]
fn read_str(lctype: u32) -> Option<String> {
    unsafe {
        // A `None` buffer asks for the required size, INCLUDING the NUL.
        let needed = GetLocaleInfoEx(PCWSTR::null(), lctype, None);
        if needed <= 1 {
            return None;
        }
        let mut buf = vec![0u16; needed as usize];
        let written = GetLocaleInfoEx(PCWSTR::null(), lctype, Some(&mut buf));
        if written <= 1 {
            return None;
        }
        // `written` counts the terminating NUL.
        let s = String::from_utf16_lossy(&buf[..(written as usize - 1)]);
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

/// A separator read, as the single `char` `LocaleSettings` stores.
///
/// Windows separators are declared as strings and are almost always one
/// character; a multi-character separator cannot be represented, so it is
/// refused rather than truncated to its first character — half a separator is a
/// worse answer than the table's.
#[cfg(windows)]
fn read_char(lctype: u32) -> Option<char> {
    let s = read_str(lctype)?;
    let mut chars = s.chars();
    let first = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    Some(first)
}

/// `LOCALE_SCURRENCY` + `LOCALE_ICURRENCY` as the symbol/position pair
/// `LocaleSettings` stores.
///
/// Windows' `ICURRENCY` encodes side AND spacing in one number; Calcula's
/// `CurrencyPosition` encodes only the side, so the space is folded into the
/// symbol string — which is exactly how the hand-written table already spells
/// sv-SE (`" kr"`, `After`) and de-DE (`"\u{20AC} "`, `Before`).
pub(crate) fn currency_shape(symbol: &str, mode: u32) -> (String, LocaleCurrencyPosition) {
    match mode {
        // `$1.1`  — prefix, no space
        0 => (symbol.to_string(), LocaleCurrencyPosition::Before),
        // `1.1$`  — suffix, no space
        1 => (symbol.to_string(), LocaleCurrencyPosition::After),
        // `$ 1.1` — prefix, one space
        2 => (format!("{} ", symbol), LocaleCurrencyPosition::Before),
        // `1.1 $` — suffix, one space
        3 => (format!(" {}", symbol), LocaleCurrencyPosition::After),
        // Windows documents 0-3 only. An unknown value is treated as the
        // commonest shape rather than dropped, because dropping it would leave
        // the TABLE's symbol against the OS's other fields.
        _ => (symbol.to_string(), LocaleCurrencyPosition::Before),
    }
}

/// Translate a Windows date/time PICTURE into Calcula's (Excel's) format code.
///
/// THIS IS NOT OPTIONAL, and the counter-example is on the machine this was
/// written on. Swedish `LOCALE_SLONGDATE` is `'den 'd MMMM yyyy`. Calcula's
/// lexer lists `'` in its literal pass-through set and has no quoting rule for
/// it, so every character INSIDE the Windows quotes is lexed as a date token:
/// serial 45306 renders as `'15en '15 januari 2024` instead of
/// `den 15 januari 2024`.
///
/// The rest of the two grammars agree more than they differ, and the agreement
/// is not luck — both descend from the same Windows date picture:
///
/// | Windows | Calcula | translation |
/// |---|---|---|
/// | `d dd ddd dddd` | same tokens | none |
/// | `M MM MMM MMMM` | same tokens (the lexer is case-insensitive) | none |
/// | `y yy yyyy` | same tokens | none |
/// | `m mm s ss` | same tokens | none |
/// | `H HH` / `h hh` | one pair of hour tokens; 12-vs-24 is decided ONLY by the presence of an AM/PM token | none |
/// | `/ : . , -` and space | literal inside a datetime section | none |
/// | `'text'` | `"text"` | **required** |
/// | `t` / `tt` | `AM/PM` | **required** |
/// | `g` / `gg` (era) | no token exists | **dropped** |
///
/// THE `H` + `tt` INTERACTION, which the obvious table misses. Calcula decides
/// 12- versus 24-hour SOLELY by whether the section carries an AM/PM token —
/// case of the hour letter is discarded by the lexer. Windows decides it by the
/// case of the hour letter and treats the designator as decoration. So a user
/// who sets a custom `H:mm tt` in Region ▸ Additional settings means 24-hour
/// with a designator; a blind `tt` -> `AM/PM` rewrite would render it 12-hour.
/// The designator is therefore dropped when the pattern's hour run is uppercase
/// `H`, which is the only spelling that can express Windows' intent here.
///
/// Everything else outside a quoted run that is not in Calcula's date/time
/// alphabet is BACKSLASH-ESCAPED. `;` splits sections, `_` and `*` consume the
/// character after them, `[` opens a bracket token: none occur in an ordinary
/// Windows picture, which is exactly why an unguarded translator would ship and
/// then break on somebody's unusual custom short date.
pub(crate) fn win_pattern_to_excel(pattern: &str) -> String {
    // Windows uses `H`/`HH` for 24-hour. Detected before any rewriting, because
    // the designator can precede or follow the hour.
    //
    // QUOTED RUNS ARE SKIPPED. Scanning the whole pattern found an `H` inside
    // literal TEXT — `'Hora 'h:mm tt` is a legal custom time format, and there
    // the `H` is a letter of a Spanish word, not an hour token. Treating it as
    // one suppressed the designator and rendered 13:30 as `1:30` with nothing
    // to say which half of the day it was: the exact ambiguity the `tt`
    // translation exists to prevent.
    let forces_24_hour = {
        let mut in_literal = false;
        let mut found = false;
        for c in pattern.chars() {
            match c {
                '\'' => in_literal = !in_literal,
                'H' if !in_literal => found = true,
                _ => {}
            }
        }
        found
    };

    let mut out = String::with_capacity(pattern.len() + 8);
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            // A Windows literal run. `''` inside it is one apostrophe.
            '\'' => {
                let mut literal = String::new();
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        if i + 1 < chars.len() && chars[i + 1] == '\'' {
                            literal.push('\'');
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    literal.push(chars[i]);
                    i += 1;
                }
                // A double quote inside the run would CLOSE Calcula's literal,
                // so it is escaped rather than re-emitted.
                out.push('"');
                for lc in literal.chars() {
                    if lc == '"' {
                        out.push('\\');
                    }
                    out.push(lc);
                }
                out.push('"');
            }
            // The AM/PM designator: `t` or `tt`.
            't' | 'T' => {
                let run = run_length(&chars, i, |x| x == 't' || x == 'T');
                if !forces_24_hour {
                    out.push_str("AM/PM");
                }
                i += run;
            }
            // The era. Calcula has no era token and Excel has none either; a
            // pass-through would print a literal `g`.
            'g' | 'G' => {
                i += run_length(&chars, i, |x| x == 'g' || x == 'G');
            }
            // Calcula's own date/time alphabet, plus the punctuation its lexer
            // renders literally inside a datetime section.
            'd' | 'D' | 'M' | 'm' | 'y' | 'Y' | 'h' | 'H' | 's' | 'S' | '/' | ':' | '.' | ','
            | '-' | ' ' => {
                out.push(c);
                i += 1;
            }
            // Anything else is escaped so it cannot be mistaken for syntax.
            _ => {
                out.push('\\');
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn run_length(chars: &[char], start: usize, pred: impl Fn(char) -> bool) -> usize {
    let mut n = 0;
    while start + n < chars.len() && pred(chars[start + n]) {
        n += 1;
    }
    n.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----------------------------------------------------------------------
    // The translator is PURE, so all of this runs on any machine, with no
    // Windows call and no dependence on how this one is configured.
    // ----------------------------------------------------------------------

    /// THE TABLE IS THE TRANSLATOR'S ORACLE. For every locale Calcula already
    /// carries a hand-written pattern for, feeding the real Windows picture
    /// through the translator must reproduce that pattern's MEANING. Where the
    /// spellings differ only in case they are the same string to the engine's
    /// lexer, which counts token runs case-insensitively.
    #[test]
    fn translating_the_real_windows_pictures_reproduces_the_hand_written_table() {
        // (locale, LOCALE_SLONGDATE, LOCALE_STIMEFORMAT) measured from Windows.
        let cases = [
            ("en-US", "dddd, MMMM d, yyyy", "h:mm:ss tt"),
            ("sv-SE", "'den 'd MMMM yyyy", "HH:mm:ss"),
            ("de-DE", "dddd, d. MMMM yyyy", "HH:mm:ss"),
            ("fr-FR", "dddd d MMMM yyyy", "HH:mm:ss"),
        ];
        for (id, long_date, time) in cases {
            let table = LocaleSettings::from_locale_id(id);
            assert_eq!(
                win_pattern_to_excel(long_date).to_lowercase(),
                table.long_date_format.to_lowercase(),
                "{} long date",
                id
            );
            assert_eq!(
                win_pattern_to_excel(time).to_lowercase(),
                table.time_format.to_lowercase(),
                "{} time",
                id
            );
        }
    }

    /// The live counter-example. Passed through untranslated, the inner text of
    /// a Windows literal is lexed as date tokens and `'den '` renders `'15en '`.
    #[test]
    fn a_windows_literal_becomes_a_calcula_literal() {
        assert_eq!(win_pattern_to_excel("'den 'd MMMM yyyy"), "\"den \"d MMMM yyyy");
        assert_eq!(
            win_pattern_to_excel("yyyy'\u{5E74}'M'\u{6708}'d'\u{65E5}'"),
            "yyyy\"\u{5E74}\"M\"\u{6708}\"d\"\u{65E5}\""
        );
        assert_eq!(
            win_pattern_to_excel("d MMMM yyyy '\u{0433}.'"),
            "d MMMM yyyy \"\u{0433}.\""
        );
    }

    /// `''` inside a Windows literal is one apostrophe, and a double quote in
    /// there would close Calcula's literal if it were re-emitted bare.
    #[test]
    fn quotes_inside_a_literal_are_carried_across_intact() {
        assert_eq!(win_pattern_to_excel("'o''clock'"), "\"o'clock\"");
        assert_eq!(win_pattern_to_excel("'say \"hi\"'"), "\"say \\\"hi\\\"\"");
    }

    /// `tt` is not a Calcula token: passed through it prints a literal `tt`,
    /// AND — because the engine decides 12-vs-24 hour solely by the presence of
    /// an AM/PM token — it leaves `h:mm:ss tt` rendering as `13:30:00 tt`.
    #[test]
    fn the_windows_designator_becomes_calculas_am_pm_token() {
        assert_eq!(win_pattern_to_excel("h:mm:ss tt"), "h:mm:ss AM/PM");
        assert_eq!(win_pattern_to_excel("h:mm t"), "h:mm AM/PM");
    }

    /// THE INTERACTION THE OBVIOUS TABLE MISSES. Windows decides 24-hour by the
    /// CASE of the hour letter and treats the designator as decoration; Calcula
    /// decides it by the presence of an AM/PM token and discards the case. A
    /// custom `H:mm tt` — reachable from Region > Additional settings — would
    /// therefore render 12-hour under a blind rewrite, which is the opposite of
    /// what the user asked Windows for.
    #[test]
    fn an_uppercase_hour_suppresses_the_designator_rather_than_flipping_to_12_hour() {
        assert_eq!(win_pattern_to_excel("H:mm tt"), "H:mm ");
        assert_eq!(win_pattern_to_excel("HH:mm:ss"), "HH:mm:ss");
        // ...and a lowercase hour still gets its designator.
        assert_eq!(win_pattern_to_excel("hh:mm tt"), "hh:mm AM/PM");
    }

    /// AN `H` INSIDE A LITERAL IS A LETTER, NOT AN HOUR. `'Hora 'h:mm tt` is a
    /// legal custom time format; treating its `H` as a 24-hour token dropped
    /// the designator and rendered 13:30 as `1:30` with nothing to say which
    /// half of the day it was.
    #[test]
    fn an_h_inside_a_literal_does_not_count_as_a_24_hour_token() {
        assert_eq!(
            win_pattern_to_excel("'Hora 'h:mm tt"),
            "\"Hora \"h:mm AM/PM"
        );
        // The control: the same literal beside a genuinely 24-hour pattern
        // still suppresses the designator.
        assert_eq!(win_pattern_to_excel("'Hora 'H:mm tt"), "\"Hora \"H:mm ");
    }

    /// Custom short dates are the case open-items 1.3 names by example, and
    /// they need no translation at all — which is the point: the two grammars
    /// agree everywhere except quoting, the designator and the era.
    #[test]
    fn ordinary_custom_short_dates_pass_through_unchanged() {
        assert_eq!(win_pattern_to_excel("dd-MMM-yy"), "dd-MMM-yy");
        assert_eq!(win_pattern_to_excel("d.M.yyyy"), "d.M.yyyy");
        assert_eq!(win_pattern_to_excel("yyyy-MM-dd"), "yyyy-MM-dd");
        assert_eq!(win_pattern_to_excel("M/d/yyyy"), "M/d/yyyy");
    }

    /// Calcula has no era token, so a pass-through would print a literal `g`
    /// in the middle of every date.
    #[test]
    fn the_era_is_dropped_rather_than_printed_as_a_letter() {
        assert_eq!(win_pattern_to_excel("gg yyyy-MM-dd"), " yyyy-MM-dd");
    }

    /// `;` splits sections, `_` and `*` consume the next character and `[`
    /// opens a bracket token. None appear in an ordinary Windows picture, which
    /// is exactly why an unguarded translator ships and then breaks once.
    #[test]
    fn characters_that_are_calcula_syntax_are_escaped_not_passed_through() {
        assert_eq!(win_pattern_to_excel("dd;MM"), "dd\\;MM");
        assert_eq!(win_pattern_to_excel("dd_MM"), "dd\\_MM");
        assert_eq!(win_pattern_to_excel("dd[MM]"), "dd\\[MM\\]");
        assert_eq!(win_pattern_to_excel("dd*MM"), "dd\\*MM");
    }

    /// `ICURRENCY` folds side and spacing into one number; the table's own
    /// spellings are the expected output, so this is checked against them.
    #[test]
    fn the_currency_shape_reproduces_the_tables_spellings() {
        assert_eq!(currency_shape("$", 0), ("$".to_string(), LocaleCurrencyPosition::Before));
        assert_eq!(currency_shape("kr", 1), ("kr".to_string(), LocaleCurrencyPosition::After));
        assert_eq!(
            currency_shape("\u{20AC}", 2),
            ("\u{20AC} ".to_string(), LocaleCurrencyPosition::Before)
        );
        assert_eq!(currency_shape("kr", 3), (" kr".to_string(), LocaleCurrencyPosition::After));

        // sv-SE, measured: SCURRENCY = "kr", ICURRENCY = 3. The table spells it
        // `" kr"` / After, byte for byte.
        let table = LocaleSettings::from_locale_id("sv-SE");
        let (sym, pos) = currency_shape("kr", 3);
        assert_eq!(sym, table.currency_symbol);
        assert_eq!(pos as u8, table.currency_position as u8);
    }

    /// The whole read must be non-panicking, because `create_app_state()` calls
    /// it and that runs inside the app-lib unit-test binary.
    #[test]
    fn reading_the_system_locale_never_panics_and_answers_something_usable() {
        let s = system_locale_settings();
        assert!(!s.locale_id.is_empty());
        assert!(!s.date_format.is_empty());
        assert!(!s.long_date_format.is_empty());
        assert!(!s.time_format.is_empty());
        // A separator is a single character by construction.
        assert!(s.decimal_separator != s.thousands_separator);
    }
}
