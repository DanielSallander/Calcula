//! FILENAME: core/engine/src/number_text.rs
//! PURPOSE: THE number<->text pair. One parser that turns text into a number
//!          the way Excel does, and one formatter that turns a number into text
//!          the way Excel does. Nothing else in the engine may grow a second
//!          copy of either half.
//!
//! ## Why one module and not two helpers
//!
//! Six separately-filed defects were the same two missing pieces:
//!
//!   * `="5%"+0`, `="1 000"+0`, `="$5"+0` and `="2020-01-01"+1` all answered
//!     `#VALUE!`, because `EvalResult::as_number` reached for Rust's bare
//!     `f64::from_str`, which knows exactly one dialect and it is not Excel's;
//!   * `="1,5"+0` failed and `="1.5"+0` SUCCEEDED on the shipping sv-SE
//!     build — precisely backwards, because `f64::from_str` has no locale;
//!   * `="inf"+0` produced a NON-FINITE number, because `f64::from_str` accepts
//!     `inf`/`infinity`/`NaN` and Excel accepts none of them;
//!   * `="Total: "&1,5` rendered "Total: 1.5" in sv-SE, because
//!     `EvalResult::as_text` used Rust's shortest-round-trip `Display`, which
//!     is 16-17 significant digits with a hard-coded `.`.
//!
//! The two halves are in ONE file because they are one contract: **whatever the
//! formatter emits, the parser must accept, in the same locale.** That is
//! asserted directly (`a_formatted_number_parses_back_in_both_dialects`), and it
//! is the property a split would quietly lose the first time one side learned a
//! new spelling.
//!
//! ## The locale is not decoration
//!
//! In sv-SE the decimal separator is `,` and the group separator is a
//! NON-BREAKING space. A parser that hard-codes `.`/`,` is not "slightly
//! anglocentric"; it refuses the shipping locale's own numbers and accepts a
//! foreign spelling in their place. Both halves therefore take a
//! [`NumberTextLocale`], and the evaluator installs the ambient one for the
//! duration of a top-level evaluation (see [`begin`]).
//!
//! ## What this module is NOT
//!
//! It is not the CELL DISPLAY path. `number_format.rs` renders a stored value
//! through the cell's number format, honours width, currency, colours and
//! custom codes, and is reached from the renderer. This module is the VALUE
//! path: what `&`, `LEN`, `TEXT`'s passthrough and every text function see when
//! a number arrives, and what arithmetic sees when text arrives. The two agree
//! on WHEN scientific notation starts ([`SCI_MIN_EXPONENT`] mirrors
//! `format_general`'s `1e15`/`1e-4`) and deliberately differ on PRECISION,
//! because display is bounded by column width and a string is not.

use crate::locale::LocaleSettings;
use std::cell::Cell;

// ============================================================================
// The locale the two halves share
// ============================================================================

/// The only two things reading or writing a number-as-text depends on.
///
/// DELIBERATELY `Copy` AND TINY. It is installed in a thread-local for the
/// duration of an evaluation and read from `as_number`'s text arm, which sits
/// under every arithmetic operator in the language; anything that needed an
/// `Arc` clone or a `RefCell` borrow per read would put an allocation-shaped
/// cost on `=A1+B1`.
///
/// The currency symbol is deliberately absent — see [`is_currency_sign`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NumberTextLocale {
    /// `.` in en-US, `,` in sv-SE and most of Europe.
    pub decimal: char,
    /// `,` in en-US, U+00A0 (non-breaking space) in sv-SE, `.` in de-DE.
    pub thousands: char,
}

impl NumberTextLocale {
    /// The invariant (en-US) dialect: `1,234.5`.
    pub const INVARIANT: NumberTextLocale = NumberTextLocale { decimal: '.', thousands: ',' };

    /// The dialect of a workbook's regional settings.
    pub fn of(locale: &LocaleSettings) -> Self {
        NumberTextLocale {
            decimal: locale.decimal_separator,
            thousands: locale.thousands_separator,
        }
    }
}

impl Default for NumberTextLocale {
    fn default() -> Self {
        Self::INVARIANT
    }
}

thread_local! {
    /// The dialect in force on this thread, or `None` outside any evaluation.
    ///
    /// A `Cell<Option<..>>` of two `char`s — no lazy init, no borrow flag, no
    /// allocation — because `active()` is on the path of every text operand of
    /// every arithmetic operator.
    static ACTIVE: Cell<Option<NumberTextLocale>> = const { Cell::new(None) };
}

/// RAII installation of the dialect for one top-level evaluation.
///
/// SAVES AND RESTORES rather than being a no-op when nested, for the same
/// reason `row_visibility::VisibilityPassGuard` does: the locale is an ANSWER,
/// not a cache, so an inner evaluator that carries a different one must win for
/// its own duration and hand the outer one back afterwards.
pub struct LocaleScope {
    previous: Option<NumberTextLocale>,
}

/// Install `locale` for the current thread until the returned guard drops.
pub fn begin(locale: NumberTextLocale) -> LocaleScope {
    LocaleScope { previous: ACTIVE.replace(Some(locale)) }
}

impl Drop for LocaleScope {
    fn drop(&mut self) {
        ACTIVE.set(self.previous.take());
    }
}

/// The dialect in force, or the invariant one.
///
/// FAILS SAFE, and that is the whole reason it is not a `Result`: an
/// `EvalResult` reached from outside any evaluation (a unit test, a script
/// bridge, a pivot expression) reads and writes `1234.5` — exactly what this
/// engine did before the locale existed. A forgotten install costs the
/// separators, never the answer.
#[inline]
pub fn active() -> NumberTextLocale {
    ACTIVE.get().unwrap_or(NumberTextLocale::INVARIANT)
}

// ============================================================================
// THE PARSER
// ============================================================================

/// Whether text that spells a DATE may become that date's serial number.
///
/// TWO CALLERS, TWO ANSWERS, and conflating them silently destroys data.
/// Arithmetic coercion wants it — `="2020-01-01"+1` is a common idiom and Excel
/// answers with the next day's serial. The TYPED-ENTRY ladder in
/// `parse_cell_input_in_format` must NOT have it, because that ladder tries the
/// number rung BEFORE its own (locale-aware, much richer) date rung: a date
/// swallowed here would be stored as a bare serial with no date format, so the
/// user types `2020-01-01` and the cell shows `43831`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateText {
    /// Text that looks like a date is not a number. The entry ladder's answer.
    Reject,
    /// `YYYY-MM-DD` becomes its serial, `hh:mm[:ss]` becomes its fraction of a
    /// day, and `YYYY-MM-DD hh:mm[:ss]` becomes the sum. Arithmetic coercion's
    /// answer.
    ///
    /// THE TIME HALF IS NOT A SEPARATE KNOB, deliberately. A date-time serial
    /// is ONE number whose integer part is the date and whose fraction IS the
    /// time; a policy that accepted `"2020-01-01"` and refused `"12:00"` would
    /// answer half of `="2020-01-01 12:00"+0` and is the state this module
    /// shipped in — `="12:00"+0` was `#VALUE!` where Excel answers 0.5. Both
    /// callers want both halves or neither.
    ///
    /// ISO ONLY, deliberately, and the omission is the point. `6/1/2020` is
    /// June 1st in en-US and does not exist in sv-SE (whose short date is
    /// year-first), and nothing in `LocaleSettings` that reaches the engine
    /// says which reading a given machine wants; guessing produces a plausible
    /// wrong DATE, which is the worst possible failure here because nothing on
    /// the cell says the part number "1-2-3" was read as a date. The full
    /// locale-aware ladder for typed entry lives in the host
    /// (`parse_date_time_input`), where the destination and the regional
    /// settings are both in view, and is NOT duplicated here.
    AcceptIso,
}

/// Whether a currency sign may be stepped over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurrencyText {
    /// `"$5"` is text. The TYPED-ENTRY ladder's answer, and it is about not
    /// LOSING something rather than about not understanding it: Excel reads
    /// `$5` as the number 5 AND applies a currency format, so the `$` the user
    /// typed stays on screen. Calcula's ladder has no currency rung yet, so
    /// reading the number here would store a bare `5` and the `$` would vanish
    /// — strictly worse for the user's eye than today's text cell. When the
    /// ladder grows that rung, this is the flag it flips.
    Reject,
    /// `"$5"` is 5. Arithmetic coercion's answer: `="$5"+0` is 5 in Excel, and
    /// there is no format to lose because the result is a number, not a cell.
    Accept,
}

/// Whether a percent sign may be read as "divide by a hundred".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PercentText {
    /// `"5%"` is text. THE CRITERIA FAMILY'S ANSWER, and it is about symmetry
    /// rather than about ignorance. `COUNTIF` compares a criteria to a STORED
    /// value; if the cell holding the literal characters `5%` were read as
    /// 0.05, then `=COUNTIF(rng,0.05)` would silently count a text cell that
    /// says "5%" on screen — which is what this engine did, because
    /// `parse_criteria` used the old `f64::from_str` while `matches_criteria`
    /// had already been moved to the rich coercion parser. Whatever the two
    /// sides do they must do the SAME, so the presentational spellings
    /// (percent, currency, date) are off on both.
    Reject,
    /// `"5%"` is 0.05, and `"50%%"` is 0.005 as in Excel. Arithmetic
    /// coercion's answer, and typed entry's.
    Accept,
}

/// The three questions on which this module's callers genuinely disagree.
///
/// EVERYTHING ELSE IS SHARED — the sign, the separators, the grouping rule, the
/// exponent and every refusal. Callers with policies is the point of this type:
/// the alternative that shipped for years was several PARSERS, which is how
/// `="1,5"+0` and typing `1,5` came to disagree about what a comma means, and
/// how `=VALUE("5%")` and `="5%"+0` came to disagree about what a percent is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsePolicy {
    pub dates: DateText,
    pub currency: CurrencyText,
    pub percent: PercentText,
}

impl ParsePolicy {
    /// What `EvalResult::as_number` uses: text arriving at an operator. Also
    /// what `VALUE()` uses — `=VALUE(A1)` and `=A1+0` are the two spellings of
    /// one question and answered differently until they shared this.
    pub const COERCION: ParsePolicy = ParsePolicy {
        dates: DateText::AcceptIso,
        currency: CurrencyText::Accept,
        percent: PercentText::Accept,
    };

    /// What the host's typed-entry ladder uses. See each variant for why.
    pub const ENTRY: ParsePolicy = ParsePolicy {
        dates: DateText::Reject,
        currency: CurrencyText::Reject,
        percent: PercentText::Accept,
    };

    /// What BOTH SIDES of a `COUNTIF`/`SUMIF`/`AVERAGEIF`/`*IFS`/D-function
    /// criteria comparison use.
    ///
    /// Plain numbers only, in the WORKBOOK'S OWN DIALECT. The locale half is
    /// the fix: with `f64::from_str` here, a Swedish user's
    /// `=COUNTIF(A1:A2,">1,5")` matched nothing while the foreign `">1.5"`
    /// worked, i.e. the shipping locale's own decimal spelling was the one that
    /// failed. The three rejections are the symmetry half: a criteria and a
    /// cell must be read the same way, and reading them richly is what let
    /// `=COUNTIF(rng,0.05)` count a text cell whose contents are `5%`.
    pub const CRITERIA: ParsePolicy = ParsePolicy {
        dates: DateText::Reject,
        currency: CurrencyText::Reject,
        percent: PercentText::Reject,
    };

    /// What the OPERAND OF A CRITERIA STRING is read with — the `2025-01-01`
    /// in `">=2025-01-01"`.
    ///
    /// `CRITERIA` with ISO dates accepted, and nothing else changed. The
    /// symmetry argument above is right for percent and currency, where the
    /// cell genuinely stores TEXT, and it INVERTS for dates: a cell typed
    /// `2025-01-15` stores its serial as a NUMBER, so the range side of a date
    /// comparison was numeric already and rejecting the date here left the
    /// criteria side unable to produce the number it had to be compared with.
    /// `=COUNTIF(rng,">=2025-01-01")` answered 0 and — worse — the negated
    /// `"<>2025-01-15"` fell through to an exact-text compare no number ever
    /// equals and KEPT the row it was told to drop (BUG-0115). This policy is
    /// for the literal only; a text cell in the RANGE reading `2025-01-01` is
    /// still read with `CRITERIA` and still does not match, as in Excel.
    pub const CRITERIA_LITERAL: ParsePolicy = ParsePolicy {
        dates: DateText::AcceptIso,
        currency: CurrencyText::Reject,
        percent: PercentText::Reject,
    };

    /// What `NUMBERVALUE()` uses — with a locale BUILT FROM ITS ARGUMENTS, not
    /// from the workbook. Overriding the workbook's separators is the entire
    /// reason that function exists, so the locale is the caller's; only the
    /// spellings are decided here. Excel's NUMBERVALUE honours a trailing
    /// percent (`NUMBERVALUE("3.5%")` is 0.035) and has no currency or date
    /// rung.
    pub const NUMBERVALUE: ParsePolicy = ParsePolicy {
        dates: DateText::Reject,
        currency: CurrencyText::Reject,
        percent: PercentText::Accept,
    };
}

/// Every character Excel will treat as a group separator when the locale's own
/// group separator is a space.
///
/// A user types U+0020 and Windows' regional settings say U+00A0; refusing the
/// one the keyboard produces would make `="1 000"+0` fail on the very locale
/// the group separator was read from. Narrow no-break (U+202F) and thin
/// (U+2009) space are the other two a paste from a web page or Word carries.
const SPACE_GROUP_SEPARATORS: [char; 4] = ['\u{0020}', '\u{00A0}', '\u{202F}', '\u{2009}'];

/// Whether `ch` is a currency sign this parser will step over.
///
/// A DELIBERATE SUPERSET OF EXCEL, stated so nobody "fixes" it later. Excel
/// accepts only the workbook locale's own currency symbol, so `="€5"+0` is
/// `#VALUE!` in an en-US workbook. Calcula accepts any Unicode currency SIGN,
/// which turns a refusal into an answer and never the other way round — the
/// direction that cannot lose data.
///
/// What is NOT accepted is a currency symbol made of LETTERS: sv-SE's is
/// `" kr"`, and treating letters as strippable would make `="5 kr"+0` differ
/// from `="5 kg"+0` for no reason a user could predict. Those stay `#VALUE!`,
/// as they are in Excel.
fn is_currency_sign(ch: char) -> bool {
    matches!(ch,
        '\u{0024}'              // $
        | '\u{00A2}'..='\u{00A5}' // cent, pound, currency, yen
        | '\u{058F}' | '\u{060B}' | '\u{07FE}' | '\u{07FF}'
        | '\u{09F2}'..='\u{09F3}' | '\u{09FB}' | '\u{0AF1}' | '\u{0BF9}'
        | '\u{0E3F}' | '\u{17DB}'
        | '\u{20A0}'..='\u{20C0}' // the Currency Symbols block (incl. € ₹ ₽)
        | '\u{A838}' | '\u{FDFC}' | '\u{FE69}' | '\u{FF04}'
        | '\u{FFE0}'..='\u{FFE1}' | '\u{FFE5}'..='\u{FFE6}'
    )
}

/// Turn text into the number Excel would read from it, or `None`.
///
/// # What is accepted
///
/// Leading and trailing whitespace; one leading sign; a currency sign before or
/// after the number; the LOCALE's decimal separator; the LOCALE's group
/// separator in correctly-sized groups; scientific notation; and any number of
/// leading or trailing percent signs (`"50%%"` is 0.005, as in Excel). Under
/// [`DateText::AcceptIso`], also an ISO date, a time of day, and the two
/// together — one serial, integer part the date and fraction the time.
///
/// Three of those are POLICY, not universal: currency, percent and date/time
/// are each off for some caller. See [`ParsePolicy`].
///
/// # What is refused, and why refusing is the feature
///
/// Every spelling of infinity and NaN — `inf`, `Infinity`, `+inf`, `NaN`,
/// `nan` — which Rust's `f64::from_str` accepts and Excel does not. This is not
/// a blacklist: the normalized string handed to `from_str` is BUILT from ASCII
/// digits, at most one `.`, at most one sign and a validated exponent, so no
/// alphabetic spelling can survive to reach it, and the finiteness check
/// afterwards catches overflow (`"1e400"`). A blacklist would have missed
/// `"infinity"`, `"INF"`, and the `("i"&"nf")` route that produced a non-finite
/// number the grid then called `ISNUMBER` on.
///
/// Also refused: mis-sized groups (`"1,23"` in en-US is NOT 123 — see
/// [`groups_are_well_formed`]), a group separator after the decimal point, a
/// bare sign, an empty or whitespace-only string, hex and Rust's `1_000`.
pub fn parse(text: &str, locale: NumberTextLocale, policy: ParsePolicy) -> Option<f64> {
    let s = text.trim();
    if s.is_empty() {
        return None;
    }
    let accepts_currency = policy.currency == CurrencyText::Accept;
    let accepts_percent = policy.percent == PercentText::Accept;

    // DATES AND TIMES FIRST, because neither can also be a valid number and the
    // number scan below would spend the whole string proving it.
    if policy.dates == DateText::AcceptIso {
        if let Some(serial) = parse_iso_date_time(s) {
            return Some(serial);
        }
    }

    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    let n = chars.len();

    let mut negative = false;
    let mut seen_sign = false;
    let mut seen_currency = false;
    let mut percents = 0u32;

    // PREFIX: sign, currency sign and leading percent, in any order, each at
    // most once (percent may repeat). Excel accepts "-$5" and "$-5" alike.
    loop {
        if i >= n {
            return None;
        }
        match chars[i] {
            '+' | '-' if !seen_sign => {
                negative = chars[i] == '-';
                seen_sign = true;
                i += 1;
            }
            '%' if accepts_percent => {
                percents += 1;
                i += 1;
            }
            c if accepts_currency && is_currency_sign(c) && !seen_currency => {
                seen_currency = true;
                i += 1;
            }
            // Whitespace is allowed only BETWEEN prefix tokens ("$ 5", "- 5"),
            // never inside the digits — a space there is a group separator and
            // is validated as one.
            c if c.is_whitespace() && (seen_sign || seen_currency || percents > 0) => {
                i += 1;
            }
            _ => break,
        }
    }

    // MANTISSA: integer digits (with groups), optional fraction, no exponent yet.
    let mut int_digits = String::new();
    let mut groups: Vec<usize> = vec![0];
    while i < n {
        let c = chars[i];
        if c.is_ascii_digit() {
            int_digits.push(c);
            *groups.last_mut().expect("groups is never empty") += 1;
            i += 1;
        } else if is_group_separator(c, locale) && matches!(chars.get(i + 1), Some(d) if d.is_ascii_digit())
        {
            // ONLY WHEN A DIGIT FOLLOWS. A space-grouping locale is the reason:
            // in sv-SE the group separator IS a space, so `"5 kr"` and the
            // Swedish spelling of a percentage, `"5 %"`, would otherwise open a
            // group that never gets its three digits and turn a legible refusal
            // (`"5 kr"`) or a legible answer (`"5 %"` = 0.05) into the wrong one.
            groups.push(0);
            i += 1;
        } else {
            break;
        }
    }
    if !groups_are_well_formed(&groups) {
        return None;
    }

    let mut frac_digits = String::new();
    if i < n && chars[i] == locale.decimal {
        i += 1;
        while i < n && chars[i].is_ascii_digit() {
            frac_digits.push(chars[i]);
            i += 1;
        }
    }

    // A NUMBER NEEDS A DIGIT. `"."`, `"-"`, `"$"` and `"%"` are text.
    if int_digits.is_empty() && frac_digits.is_empty() {
        return None;
    }

    // EXPONENT: `e`/`E`, optional sign, at least one digit. Anything else after
    // an `e` (the `inf`/`nan` route's only way in would have been an alphabetic
    // run) leaves the string unconsumed and the trailing check below refuses it.
    let mut exponent = String::new();
    if i < n && (chars[i] == 'e' || chars[i] == 'E') {
        let mut j = i + 1;
        let mut exp = String::new();
        if j < n && (chars[j] == '+' || chars[j] == '-') {
            exp.push(chars[j]);
            j += 1;
        }
        let start_digits = j;
        while j < n && chars[j].is_ascii_digit() {
            exp.push(chars[j]);
            j += 1;
        }
        if j > start_digits {
            exponent = exp;
            i = j;
        }
    }

    // SUFFIX: trailing percent signs, a trailing currency sign, whitespace.
    while i < n {
        match chars[i] {
            '%' if accepts_percent => {
                percents += 1;
                i += 1;
            }
            c if accepts_currency && is_currency_sign(c) && !seen_currency => {
                seen_currency = true;
                i += 1;
            }
            c if c.is_whitespace() => i += 1,
            // ANY other trailing character means this was never a number.
            // "5kr", "5x", "1,5,5" and "12abc" all land here.
            _ => return None,
        }
    }

    // THE NORMALIZED STRING IS BUILT, NEVER EDITED FROM THE INPUT. Only ASCII
    // digits, at most one '.', at most one leading '-', and an exponent whose
    // every character was validated above can appear in it — which is what
    // makes "inf"/"NaN" structurally unreachable rather than merely unlisted.
    let mut normalized = String::with_capacity(int_digits.len() + frac_digits.len() + 8);
    if negative {
        normalized.push('-');
    }
    normalized.push_str(if int_digits.is_empty() { "0" } else { &int_digits });
    if !frac_digits.is_empty() {
        normalized.push('.');
        normalized.push_str(&frac_digits);
    }
    if !exponent.is_empty() {
        normalized.push('e');
        normalized.push_str(&exponent);
    }

    let mut value: f64 = normalized.parse().ok()?;
    for _ in 0..percents {
        value /= 100.0;
    }
    // OVERFLOW IS NOT A NUMBER. "1e400" parses to +inf in IEEE-754; letting it
    // through would put a non-finite value in a cell that `ISNUMBER` calls TRUE
    // and every later comparison mis-answers.
    if !value.is_finite() {
        return None;
    }
    Some(value)
}

/// Whether `ch` separates thousands in this locale.
///
/// Space-family separators are interchangeable (see
/// [`SPACE_GROUP_SEPARATORS`]); everything else must match exactly, so a `.`
/// in en-US stays the decimal point and never becomes a silently-dropped group
/// mark.
fn is_group_separator(ch: char, locale: NumberTextLocale) -> bool {
    if SPACE_GROUP_SEPARATORS.contains(&locale.thousands) {
        return SPACE_GROUP_SEPARATORS.contains(&ch);
    }
    ch == locale.thousands
}

/// Whether the digit counts between group separators are a real grouping.
///
/// WHY THIS IS VALIDATED INSTEAD OF STRIPPED. "Strip the group separator and
/// parse what is left" is the obvious implementation and it answers `"1,5"` in
/// en-US with **15**. That is a European user's one-and-a-half turned into
/// fifteen, in a cell, with no error on it — the exact class of silent wrong
/// answer this whole module exists to remove. Excel refuses it, and so does
/// this.
///
/// The rule: with no separator, anything goes (including no digits at all, for
/// `".5"`). With separators, the first group holds 1-3 digits and every later
/// group holds exactly 3.
fn groups_are_well_formed(groups: &[usize]) -> bool {
    if groups.len() == 1 {
        return true;
    }
    if groups[0] == 0 || groups[0] > 3 {
        return false;
    }
    groups[1..].iter().all(|&g| g == 3)
}

/// `YYYY-MM-DD`, `hh:mm[:ss]` (with an optional `AM`/`PM`), or the two
/// separated by whitespace, as one Excel serial.
///
/// ONE ENTRY POINT FOR BOTH HALVES because a serial is one number: the integer
/// part is the day and the fraction is the time, so `"2020-01-01 12:00"` has to
/// be the SUM and not a choice between the two. Splitting on whitespace first is
/// safe here because neither half may contain any: the date half is validated
/// digit-by-digit by [`parse_iso_date`] and the time half by
/// [`parse_time_of_day`], whose only optional space is the one before `AM`/`PM`
/// — which is why the time is tried on the WHOLE string first.
fn parse_iso_date_time(text: &str) -> Option<f64> {
    if let Some(serial) = parse_iso_date(text) {
        return Some(serial);
    }
    if let Some(fraction) = parse_time_of_day(text) {
        return Some(fraction);
    }
    // "<date><space><time>", the combination. `split_once` on the FIRST space
    // keeps `"2020-01-01 2:30 PM"` intact on the time side.
    let (date_part, time_part) = text.split_once(char::is_whitespace)?;
    let serial = parse_iso_date(date_part.trim())?;
    let fraction = parse_time_of_day(time_part.trim())?;
    Some(serial + fraction)
}

/// `hh:mm`, `hh:mm:ss`, optionally followed by `AM`/`PM`, as a fraction of a
/// day. `None` for anything else.
///
/// THE GUARDS ARE THE FEATURE; the arithmetic is delegated. `date_serial::
/// parse_time_string` is deliberately lax because its callers (`TIMEVALUE` and
/// the host's entry ladder) have already decided the text is a time — handed a
/// bare `"12"` it splits into one part and answers **0.5**, so calling it
/// straight from the coercion path would have made `="12"+0` half past midnight
/// instead of twelve. Hence:
///
///   * at least one `:` and at most two, so a bare number stays a number;
///   * every component all-digits, so `"a:b"` is text;
///   * minutes and seconds under 60, as in Excel — `TIMEVALUE("12:70")` is
///     `#VALUE!` there and typing `12:70` leaves a text cell;
///   * hours 0..=9999 (Excel's elapsed-time range) and 1..=12 when a meridiem
///     is present, so `"25:00"` is still 1.0416… as Excel reads it but
///     `"25:00 PM"` is text.
///
/// A SECOND time parser is what is NOT here: the AM/PM handling and the
/// 86400ths are `date_serial`'s, so the two cannot drift.
fn parse_time_of_day(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    let upper = trimmed.to_uppercase();
    let (body, meridiem) = match upper.strip_suffix("AM").or_else(|| upper.strip_suffix("PM")) {
        Some(rest) => (rest.trim_end(), true),
        None => (upper.as_str(), false),
    };

    let parts: Vec<&str> = body.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    for part in &parts {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    let hours: u32 = parts[0].parse().ok()?;
    let minutes: u32 = parts[1].parse().ok()?;
    let seconds: u32 = if parts.len() == 3 { parts[2].parse().ok()? } else { 0 };
    if minutes > 59 || seconds > 59 {
        return None;
    }
    if meridiem {
        if !(1..=12).contains(&hours) {
            return None;
        }
    } else if hours > 9999 {
        return None;
    }

    crate::date_serial::parse_time_string(trimmed)
}

/// `YYYY-MM-DD` as an Excel serial, or `None`.
///
/// GUARDED, and each guard is a defect the ungurded reading would cause:
///   * exactly FOUR year digits, so the part number `"1-2-3"` is not the 3rd of
///     February in the year 1 (`date_serial::parse_date_string` accepts it);
///   * a real calendar day, so `"2020-02-31"` is text rather than the 2nd of
///     March;
///   * 1900..=9999, the range Excel's serial epoch can express at all.
///
/// The arithmetic itself is `date_serial::date_to_serial` — the 1900 leap-year
/// fiction lives there and a second copy would drift from it on the one date
/// compatibility is judged by.
fn parse_iso_date(text: &str) -> Option<f64> {
    let mut parts = text.split('-');
    let y = parts.next()?;
    let m = parts.next()?;
    let d = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if y.len() != 4 || !y.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if m.is_empty() || m.len() > 2 || !m.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if d.is_empty() || d.len() > 2 || !d.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let year: i32 = y.parse().ok()?;
    let month: u32 = m.parse().ok()?;
    let day: u32 = d.parse().ok()?;
    if !(1900..=9999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    if day < 1 || day > crate::date_serial::days_in_month(year, month) {
        return None;
    }
    Some(crate::date_serial::date_to_serial(year, month as i32, day as i32))
}

// ============================================================================
// THE FORMATTER
// ============================================================================

/// Excel stores and reports 15 significant decimal digits. Rust's `Display`
/// reports 16-17 (the shortest string that round-trips the f64), which is why
/// `="x"&(0.1+0.2)` read `"x0.30000000000000004"` here and `"x0.3"` in Excel.
pub const SIGNIFICANT_DIGITS: usize = 15;

/// The decimal exponent at which text conversion switches to scientific.
///
/// MIRRORS `number_format::format_general`'s `1e15` on purpose: a value that a
/// cell DISPLAYS as `1e15` must not concatenate as a 301-character digit
/// string, which is what `Display` did for `1e300`.
const SCI_MIN_EXPONENT: i32 = 15;

/// The decimal exponent below which text conversion switches to scientific.
/// Mirrors `format_general`'s `1e-4`, so `0.0001` stays `0.0001` and `0.00001`
/// becomes `1E-05` on both paths.
const SCI_MAX_NEGATIVE_EXPONENT: i32 = -4;

/// Turn a number into the text Excel would show for it.
///
/// Fifteen significant digits, trailing zeros trimmed, scientific notation
/// outside [`SCI_MAX_NEGATIVE_EXPONENT`]..[`SCI_MIN_EXPONENT`], and the
/// LOCALE's decimal separator. No group separator — Excel's `&` never inserts
/// one, and inserting one here would make `=VALUE(A1&"")` locale-dependent in a
/// second, subtler way.
pub fn format(value: f64, locale: NumberTextLocale) -> String {
    // `-0.0 == 0.0`, so this arm also stops a stored negative zero from
    // concatenating as "-0" where Excel shows "0".
    if value == 0.0 {
        return "0".to_string();
    }
    if !value.is_finite() {
        // UNREACHABLE FROM A CELL — `finite_or_num` turns a non-finite
        // arithmetic result into `#NUM!` and the parser above refuses every
        // textual spelling — so this is a last resort, not a supported output.
        return format!("{}", value);
    }

    // ONE rounding step, not two. Formatting to `{:.14e}` rounds to exactly 15
    // significant digits and reports the decimal exponent, carry included
    // (9.9999999999999995e14 comes back as 1.00000000000000e15). Rounding to a
    // fixed number of DECIMALS first and then trimming would round twice and
    // drift on the last digit.
    let scientific = format!("{:.*e}", SIGNIFICANT_DIGITS - 1, value);
    // `{:e}` always emits exactly one 'e' and a parsable exponent; the
    // fallbacks exist so a future formatting change cannot panic inside the
    // renderer's process.
    let (mantissa, exponent) = match scientific.split_once('e') {
        Some((m, e)) => match e.parse::<i32>() {
            Ok(exponent) => (m.to_string(), exponent),
            Err(_) => return scientific,
        },
        None => return scientific,
    };
    let negative = mantissa.starts_with('-');
    let all_digits: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    let digits = all_digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };

    let body = if exponent >= SCI_MIN_EXPONENT || exponent < SCI_MAX_NEGATIVE_EXPONENT {
        let mut out = String::with_capacity(digits.len() + 6);
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        // "E+17"/"E-05": Excel's spelling, uppercase, sign always present, at
        // least two exponent digits.
        out.push('E');
        out.push(if exponent < 0 { '-' } else { '+' });
        let magnitude = exponent.unsigned_abs();
        if magnitude < 10 {
            out.push('0');
        }
        out.push_str(&magnitude.to_string());
        out
    } else if exponent >= 0 {
        let integer_len = exponent as usize + 1;
        if digits.len() <= integer_len {
            let mut out = String::with_capacity(integer_len);
            out.push_str(digits);
            for _ in digits.len()..integer_len {
                out.push('0');
            }
            out
        } else {
            format!("{}.{}", &digits[..integer_len], &digits[integer_len..])
        }
    } else {
        let leading_zeros = (-exponent - 1) as usize;
        let mut out = String::with_capacity(digits.len() + leading_zeros + 2);
        out.push_str("0.");
        for _ in 0..leading_zeros {
            out.push('0');
        }
        out.push_str(digits);
        out
    };

    let mut result = String::with_capacity(body.len() + 1);
    if negative {
        result.push('-');
    }
    for ch in body.chars() {
        result.push(if ch == '.' { locale.decimal } else { ch });
    }
    result
}

// ============================================================================
// SNAP TO ZERO
// ============================================================================

/// Excel's cancellation correction, applied to the FINAL add or subtract of a
/// formula.
///
/// # The rule, and exactly how much of it this is
///
/// Microsoft documents (KB 78113, "Floating-point arithmetic may give
/// inaccurate results in Excel") that from Excel 97 onwards, *"if an addition
/// or subtraction operation results in a value at or very close to zero, Excel
/// will compensate for any error introduced as a result of converting an
/// operand to and from binary"*, and gives `=1.333+1.225-1.333-1.225` — which
/// this engine answered `-2.220446049250313E-16` — as the example that must
/// now be 0.
///
/// Microsoft does not publish the threshold, so this implements the narrow
/// documented case with a threshold DERIVED rather than guessed: the result is
/// forced to zero when it is smaller than the fifteenth significant digit of
/// the larger operand, i.e. below the precision Excel keeps at all. A value
/// that cannot be distinguished from zero in the only precision the product
/// reports is zero.
///
/// # What is deliberately NOT covered
///
///   * anything that is not the final operation (`=(1.333+1.225-1.333-1.225)*1`
///     keeps the residue, as in Excel — the correction is documented for the
///     last operation only);
///   * a final add/subtract inside a lifted ARRAY operation, and a final unary
///     minus over one. Both are stated here rather than silently absent.
///
/// # The control that keeps it honest
///
/// `=1e-300-0` must stay `1e-300`. Its magnitude is tiny in absolute terms and
/// EXACTLY the magnitude of its own operand in relative terms, which is why the
/// threshold is relative and not an absolute epsilon: an absolute epsilon would
/// silently destroy every legitimate small number in the workbook.
pub fn snap_cancellation(result: f64, left: f64, right: f64) -> f64 {
    if result == 0.0 || !result.is_finite() {
        return result;
    }
    let largest = left.abs().max(right.abs());
    if !largest.is_finite() {
        return result;
    }
    // 1e-15 is "one unit in the fifteenth significant digit" — the last digit
    // Excel keeps — taken at the CONSERVATIVE end of its range. That unit is
    // between 1e-15 and 1e-14 in relative terms depending on the leading digit,
    // and the small end is chosen deliberately: the correction can then only
    // ever zero a difference Excel would not have reported anyway, and can
    // never destroy one it would. See SIGNIFICANT_DIGITS.
    if result.abs() < largest * 1e-15 {
        0.0
    } else {
        result
    }
}
