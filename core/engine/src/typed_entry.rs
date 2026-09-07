//! FILENAME: core/engine/src/typed_entry.rs
//!
//! Turn the text a person TYPES into a cell into the cell it becomes.
//!
//! This ladder used to live in `app/src-tauri/src/lib.rs`, which was the wrong
//! crate for it twice over.
//!
//! It is not app logic. It reads a string and a locale and answers with a
//! [`Cell`] and an implied number format; it touches no `AppState`, no Tauri
//! window, nothing above the engine. (Verified before the move: the region held
//! zero references to `crate::`, `AppState`, `tauri::` or `State<`.)
//!
//! And it is the definition of "what the product does with this input", which
//! means anything that has to AGREE with the product must call it. The offline
//! formula grader (`core/calcula-format/src/ai/formula_verify.rs`) is exactly
//! such a caller: it evaluates a formula against a fixture written as typed
//! text, and a grader that seeds `5.5%` as a string where the product stores
//! 0.055 does not measure the product — it measures a second implementation
//! that will drift. That crate cannot depend on the app, so the shared
//! definition had to come down here.
//!
//! A third gain, and not a small one: the ladder's own assertions now run under
//! `cargo test --workspace` from `core/`, which is the job CI gates on. In the
//! app crate they ran only where nothing watched.
//!
//! THE RUNG ORDER IS LOAD-BEARING. Each rung's comment records a bug that
//! shipped. Do not reorder or "tidy" them.
//!
//! NOTE ON FORMATTING: keep these lines flush with the `//!` marker. Rustdoc
//! reads an indented block inside a doc comment as a CODE block and tries to
//! compile it, so an indented paragraph here fails `cargo test --workspace`
//! with two dozen "unknown start of token" errors and nothing else explains why.

use crate::cell::{Cell, CellError, CellValue};
use crate::grid::Grid;
use crate::style::{NumberFormat, StyleRegistry};

pub fn parse_cell_input(input: &str, locale: &crate::LocaleSettings) -> Cell {
    parse_cell_input_with_format(input, locale).0
}

/// `parse_cell_input`, plus the number format the ENTRY ITSELF implies.
///
/// A `Cell` carries a `style_index`, not a format, and this function cannot see
/// the workbook's `StyleRegistry` — so it cannot apply the format it discovers.
/// It hands it back instead, because the VALUE alone is not the whole answer:
/// "2020-06-01" stored as serial 43983 and displayed as `43983` is not what the
/// user typed, and "50%" has had exactly that defect from the beginning (it
/// stores 0.5 and displays "0.5" unless the cell already carried a percentage
/// format).
///
/// Applying it is the caller's job, because the caller is what owns the style
/// registry: intern `styles.get(existing_index).clone().with_number_format(fmt)`
/// through `StyleRegistry::get_or_create` and assign the returned index — and
/// only when the cell's current format is `General`, so an explicit format the
/// user already chose is never overwritten by what they typed into it.
///
/// NO DESTINATION IN VIEW. This spelling cannot see where the entry lands, so
/// the Text-format rung of the ladder is dead for it. That is right for the
/// callers that genuinely have no cell (CSV/BI value conversion, the UDF edit
/// list); an entry path that DOES have one must pass it — see
/// `parse_cell_input_in_format`.
pub fn parse_cell_input_with_format(
    input: &str,
    locale: &crate::LocaleSettings,
) -> (Cell, Option<NumberFormat>) {
    parse_cell_input_in_format(input, locale, None)
}

/// Whether a number format is Excel's Text format — the `@` code, and only it.
///
/// A custom code that merely CONTAINS an `@` section (`"id "@`) is not the Text
/// category: it says how to draw text that is already there, not that whatever
/// is entered here IS text. The same one-character test decides the overflow
/// class in `api_types::overflow_class_for`, and the two must agree — a cell
/// whose entry is stored as text but whose digits are then marked '####' is a
/// contradiction visible on screen.
pub fn is_text_format(format: &NumberFormat) -> bool {
    matches!(format, NumberFormat::Custom { format } if format == "@")
}

/// The number format an entry at (row, col) actually lands in.
///
/// `Grid::effective_style_index` and NOT `cell.style_index`, because a cell's
/// own index stays 0 until something formats that exact cell — and formatting a
/// whole COLUMN as Text is how a column of ZIP codes or part numbers is
/// protected. Reading the cell's own index would make the Text format work only
/// where someone had ALSO formatted each cell individually, which is the case
/// that needs it least.
pub fn entry_format_at(
    grid: &Grid,
    styles: &StyleRegistry,
    row: u32,
    col: u32,
) -> NumberFormat {
    styles
        .get(grid.effective_style_index(row, col))
        .number_format
        .clone()
}

/// The typed-entry ladder, told which number format the entry is landing in.
///
/// `target_format` is the format that ACTUALLY applies at the destination
/// (`entry_format_at`), or `None` where there is no destination.
///
/// THE ORDER, rung by rung, and why each one sits where it does:
///
/// 1. **empty** — an empty entry is an empty cell, never a text cell.
/// 2. **leading `'`** — Excel's escape: "store the rest as text, and do not show
///    me the apostrophe". FIRST, because it overrides everything below it
///    INCLUDING rung 3: `'123` in a Text-formatted cell must store `123`, not a
///    visible apostrophe. `''abc` therefore stores `'abc`, which is Excel's own
///    way to type a literal leading apostrophe, and falls out of "the rest,
///    verbatim" rather than being a case of its own.
/// 3. **the Text format** — an entry into an `@` cell is stored as TEXT,
///    verbatim. Above `=` because Excel stores a formula typed into a
///    Text-formatted cell as the literal string too, and above the number rung
///    because that is the whole point: `007` typed into a Text cell used to be
///    stored as the NUMBER 7 and then re-rendered through `General`, so the cell
///    displayed "7" — the leading zeros destroyed, silently, which is precisely
///    the loss (part numbers, ZIP codes) the Text format exists to prevent.
/// 4. **`=` formula**.
/// 5. **TRUE/FALSE**.
/// 6. **an error literal** — `#N/A`, `#DIV/0!` and the rest; see
///    [`typed_error_literal`]. Below the Text format and the apostrophe (both of
///    which are the user saying "this is a string"), above the number rung,
///    where it cannot collide because no error literal is also a number.
/// 7. **number (and `%`)** — before dates, because a bare `43983` is the number
///    43983 and not a date.
/// 8. **date/time**.
/// 9. **leading `+`/`-` formula** — the Lotus habit; after the number rung so
///    that `-5` stays a number and only `-A1` becomes a formula. It requires
///    something to actually FOLLOW the sign; see the rung.
/// 10. **text**.
///
/// Rungs 3 and 7/8 are mirror images and must not fight: rung 3 is the FORMAT
/// deciding the value, rungs 7/8 are the VALUE implying a format. They cannot
/// both fire — rung 3 returns before them and reports no implied format, so a
/// Text-formatted cell can never have its own format overwritten by what was
/// typed into it.
pub fn parse_cell_input_in_format(
    input: &str,
    locale: &crate::LocaleSettings,
    target_format: Option<&NumberFormat>,
) -> (Cell, Option<NumberFormat>) {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return (Cell::new(), None);
    }
    // RUNG 2. The rest is stored VERBATIM — and the escape is read off the
    // input BEFORE the trailing trim, because `trimmed` is the wrong string to
    // read it from. Typing `'  007  ` is the user saying "keep exactly these
    // characters"; taking the apostrophe off `trimmed` honoured the LEADING
    // spaces and silently ate the TRAILING ones, so the one entry form that
    // exists to preserve whitespace preserved half of it. `trim_start` only, so
    // an apostrophe typed after a stray leading space is still the escape it
    // was before.
    if let Some(rest) = input.trim_start().strip_prefix('\'') {
        return (
            Cell::new_text(rest.to_string()),
            apostrophe_implied_format(rest, locale),
        );
    }
    // RUNG 3. See the ladder doc: this is the half that used to lose data.
    if target_format.is_some_and(is_text_format) {
        return (Cell::new_text(trimmed.to_string()), None);
    }
    if trimmed.starts_with('=') {
        // Delocalize the formula: convert locale separators to invariant format for storage
        let invariant = crate::delocalize_formula(trimmed, locale);
        return (Cell::new_formula(invariant), None);
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return (Cell::new_boolean(true), None);
    }
    if upper == "FALSE" {
        return (Cell::new_boolean(false), None);
    }
    // ERROR LITERALS. Without this rung `#N/A` was stored as the TEXT "#N/A" —
    // a cell that LOOKS exactly right and is wrong to every test over it:
    // `ISNA` FALSE, `IFERROR` passing it straight through, `ISTEXT` TRUE and
    // `COUNTA` counting a string. See `typed_error_literal`.
    if let Some(error) = typed_error_literal(&upper) {
        return (error_cell(error), None);
    }
    if let Some(num) = parse_number(trimmed, locale) {
        return (Cell::new_number(num), implied_percentage_format(trimmed, locale));
    }
    // DATES AND TIMES. A typed date used to stay LITERAL TEXT: "2020-06-01" was
    // a string, so every date function, every date axis and every sort treated
    // it as one, and the cell right-aligned like text. Placed AFTER
    // `parse_number` (a bare `43983` is the number 43983, not a date) and
    // before the leading +/- rule, so `-1-2` is still a formula.
    if let Some((serial, format)) = parse_date_time_input(trimmed, locale) {
        return (Cell::new_number(serial), Some(format));
    }
    // A LEADING `+` OR `-` THAT IS NOT A NUMBER STARTS A FORMULA, as it does in
    // Excel — another Lotus 1-2-3 habit it never dropped, and one a lot of
    // people still type. Placed AFTER `parse_number` so the ordinary cases keep
    // winning: `-5` and `+1,5` are numbers, `-A1` and `+SUM(A1:A9)` are not.
    //
    // ONLY WHEN SOMETHING FOLLOWS THE SIGN. `+` on its own used to reach here,
    // get an `=` prepended, and hand `Cell::new_formula` the unparsable "=+" —
    // whose error arm stores the STRING, so the cell ended up literally showing
    // `=+`, an equals sign the user never typed. Excel refuses a bare sign; the
    // fall-through below stores the one character that was actually typed.
    if (trimmed.starts_with('+') || trimmed.starts_with('-'))
        && !trimmed[1..].trim().is_empty()
    {
        let invariant = crate::delocalize_formula(trimmed, locale);
        return (Cell::new_formula(format!("={}", invariant)), None);
    }
    (Cell::new_text(trimmed.to_string()), None)
}

/// The error a typed entry SPELLS, or `None` if it merely starts with a `#`.
///
/// THE LIST IS THE LEXER'S, not a copy of it. `parser::lexer::ERROR_LITERALS` is
/// what makes `=#N/A` parse inside a formula, and a second table here would
/// drift the moment either side learned a spelling: the typed `#SPILL!` and the
/// evaluated one would then be different cells. `CellError::from_literal` maps
/// the text to the variant — but it CANNOT be the membership test on its own,
/// because its documented contract is to fall back to `Value` for anything it
/// does not recognise, which would turn the perfectly ordinary text
/// `#NOTANERROR` into `#VALUE!`.
///
/// `upper` is the already-uppercased entry, so `#n/a` is the same error as
/// `#N/A` — as it is in Excel, which re-spells what you type.
fn typed_error_literal(upper: &str) -> Option<CellError> {
    if parser::lexer::ERROR_LITERALS.contains(&upper) {
        Some(CellError::from_literal(upper))
    } else {
        None
    }
}

/// A literal error cell: a value with no AST, like a typed number or boolean.
///
/// `Cell` has constructors for number, text, boolean and formula but not for an
/// error, because until this rung existed nothing could type one.
fn error_cell(error: CellError) -> Cell {
    let mut cell = Cell::new();
    cell.value = CellValue::Error(error);
    cell
}

/// What a leading apostrophe implies about the CELL, not just about this entry.
///
/// Excel remembers the apostrophe itself — it exposes it as
/// `Range.PrefixCharacter` and leaves the cell on `General`. Calcula does NOT
/// store a prefix flag, and records the same intent as the Text format instead.
///
/// WHY NOT A STORED FLAG. The one thing the prefix drives here is the "Number
/// Stored as Text" indicator, and `error_checking.rs` derives that from the
/// VALUE (a `CellValue::Text` whose contents parse as a number), never from a
/// prefix — so a stored flag would be a second source of truth for an answer the
/// value already gives, carried on every cell of a 1M-row grid, plus a `.cala`
/// shape change to persist it.
///
/// WHAT THE FORMAT BUYS INSTEAD is the round trip, which is where the prefix
/// character earns its keep in Excel: nothing in a `CellValue::Text("123")` says
/// an apostrophe was ever typed, so the editor re-opens on `123`, and pressing
/// Enter on an OTHERWISE UNTOUCHED cell would store the number 123 and lose the
/// text. With the cell now formatted as Text, rung 3 of the ladder catches that
/// re-entry and the value survives. The price is a deliberate deviation: after
/// `'123`, typing `456` into that same cell stays text here where Excel would
/// make it a number. One is a surprise the user can undo from Format Cells; the
/// other is a leading zero nobody notices is gone.
///
/// ONLY WHEN THE APOSTROPHE CHANGED THE ANSWER. `'hello` implies nothing —
/// `hello` was already text, so formatting the cell would restrict it for no
/// gain. `'123`, `'TRUE`, `'=A1+1` and `'2020-06-01` each would have become
/// something else, and each implies Text.
///
/// `'#N/A` IS NOW IN THE FIRST GROUP, and it moved without a line changing here
/// — which is the point of asking the ladder instead of listing the cases. It
/// used to be in the second group because an unprefixed `#N/A` was already
/// text, so the apostrophe changed nothing; now that the ladder has an error
/// rung the apostrophe is the only thing standing between the string and a real
/// `#N/A` error, so the cell has to remember it or the next Enter over an
/// untouched cell turns the text into the error.
fn apostrophe_implied_format(
    rest: &str,
    locale: &crate::LocaleSettings,
) -> Option<NumberFormat> {
    // THE LADDER ITSELF decides what `rest` would have been. A second copy of
    // "does this look like a number/date/formula" is exactly the kind of
    // duplicate that drifts on the first locale change. It terminates because
    // `rest` is strictly shorter than the input that reached here, so `''x`
    // recurses once and stops.
    let (would_be, _) = parse_cell_input_in_format(rest, locale, None);
    if would_be.has_formula() {
        return Some(NumberFormat::Custom { format: "@".to_string() });
    }
    match would_be.value {
        // `Empty` is the lone apostrophe (`'`), which needs no protection.
        CellValue::Text(_) | CellValue::Empty => None,
        _ => Some(NumberFormat::Custom { format: "@".to_string() }),
    }
}

/// Parse cell input that is already in invariant (US) format.
/// Formulas are stored as-is without delocalization; numbers use '.' as decimal separator.
pub fn parse_cell_input_invariant(input: &str, locale: &crate::LocaleSettings) -> Cell {
    parse_cell_input_invariant_in_format(input, locale, None)
}

/// `parse_cell_input_invariant`, told which number format the entry lands in.
///
/// The apostrophe, the `@` format and the error literals are all DIALECT-FREE —
/// none of them reads a decimal separator — so they are the same three rungs
/// here as in the localized ladder, and a script's only way to write the text
/// "123" (or the text "#N/A") is the same escape a user types.
///
/// It returns no implied format, because this whole spelling reports none: a
/// script that means to write a date says so with a format of its own rather
/// than having one inferred from the string it passed. The consequence for the
/// apostrophe is that a script's `'123` stores text WITHOUT formatting the cell
/// as Text, so it does not get the re-entry round trip an interactive `'123`
/// does.
pub fn parse_cell_input_invariant_in_format(
    input: &str,
    locale: &crate::LocaleSettings,
    target_format: Option<&NumberFormat>,
) -> Cell {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Cell::new();
    }
    // Same reading as the localized ladder: the escape comes off the UNTRIMMED
    // input so a pasted `'  007  ` keeps both ends of its whitespace.
    if let Some(rest) = input.trim_start().strip_prefix('\'') {
        return Cell::new_text(rest.to_string());
    }
    if target_format.is_some_and(is_text_format) {
        return Cell::new_text(trimmed.to_string());
    }
    if trimmed.starts_with('=') {
        // Formula is already in invariant format — store directly
        return Cell::new_formula(trimmed.to_string());
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return Cell::new_boolean(true);
    }
    if upper == "FALSE" {
        return Cell::new_boolean(false);
    }
    // ERROR LITERALS, on this path too — because this is the path a COPY of an
    // error cell comes back through. The clipboard carries `#N/A` as text, and
    // storing it as text is how a pasted column of errors turned into a column
    // that `ISNA` calls FALSE. A script that means the string says so with the
    // same apostrophe a user types.
    if let Some(error) = typed_error_literal(&upper) {
        return error_cell(error);
    }
    // Try invariant number parsing first (dot decimal), then locale-aware
    if let Ok(n) = trimmed.parse::<f64>() {
        if n.is_finite() {
            return Cell::new_number(n);
        }
    }
    if let Some(num) = parse_number(trimmed, locale) {
        return Cell::new_number(num);
    }
    Cell::new_text(trimmed.to_string())
}

/// The NUMBER rung of the typed-entry ladder.
///
/// ONE GRAMMAR, TWO POLICIES. This is `crate::number_text::parse` — the same
/// parser `EvalResult::as_number` reaches for when text meets an operator —
/// under [`ParsePolicy::ENTRY`], which differs from the coercion policy on
/// exactly two questions (ISO dates and currency signs) for reasons stated on
/// those two enums. It used to be a second, independent implementation, and the
/// three defects that cost were measured before it was replaced:
///
///   * **`"1,5"` in en-US was FIFTEEN.** The old code stripped the group
///     separator and parsed what was left, so a European's one-and-a-half
///     became 15 in a cell with no error on it. Grouping is now VALIDATED
///     (`groups_are_well_formed`), so `"1,23"` and `"1,5"` are text, as they
///     are in Excel.
///   * **`"inf%"` stored a NON-FINITE number.** The old percent branch was the
///     one path that never checked `is_finite`, so `inf/100` went straight into
///     a cell that `ISNUMBER` then called TRUE. `inf` is now structurally
///     unreachable rather than filtered.
///   * **`"1 000"` failed in sv-SE** while `"1\u{00A0}000"` worked — the locale's
///     group separator is a NON-BREAKING space and the keyboard makes an
///     ordinary one, so the separator read off the user's own regional settings
///     rejected the way that user types it.
///
/// The deliberate NARROWING that came with it: in a comma-decimal locale the
/// old code also accepted the ANGLO spelling (`"1.5"` was 1.5 in sv-SE, while
/// `"1,5"` — the spelling that locale actually uses — was reached only by a
/// second branch). Excel refuses the foreign spelling, and so does this now.
/// Scripts and imports are unaffected: they go through
/// `parse_cell_input_invariant*`, which tries the invariant dot FIRST.
/// PUBLIC because it is a primitive in its own right — "read this string as a
/// number the way typed entry would" — and because the ladder's own assertions
/// exercise it directly rather than only through the rungs above it. Publishing
/// it keeps those assertions testing the thing they name.
pub fn parse_number(s: &str, locale: &crate::LocaleSettings) -> Option<f64> {
    crate::number_text::parse(
        s,
        crate::number_text::NumberTextLocale::of(locale),
        crate::number_text::ParsePolicy::ENTRY,
    )
}

// ============================================================================
// TYPED DATES AND TIMES
// ============================================================================
// Everything below turns what a user TYPES into an Excel date serial. Three
// rules shape it:
//
// 1. Every conversion goes through `crate::date_serial`. The 1900 leap-year
//    fiction lives there, and a second implementation of the arithmetic would
//    drift from it on the one date that matters most for compatibility.
// 2. A string that is not clearly a date stays TEXT. A wrong date is worse
//    than no date because it LOOKS right: nothing about the cell says the part
//    number "1-2-3" was read as the 2nd of January 2003.
// 3. The locale decides the numeric order, and it is read off
//    `LocaleSettings::date_format` — this build's default locale is sv-SE, so
//    a hard-coded month-first reading would be wrong for the users it ships to.
//
// ACCEPTED: `2020-06-01` (and any four-digit-year-first form), the locale's
// short-date order for `/`, `.` and `-` when a two- or four-digit year is
// present, the locale's own month names ("1 Jun 2020", "1 juni 2020",
// "Jun 1, 2020"), `13:45`, `13:45:30`, `1:45 PM` where the locale has a
// meridiem, and any date and time together (`2020-06-01 13:45`,
// `2020-06-01T13:45:00`).
//
// REFUSED, deliberately: a date with no year ("3/4", "1-2", "12/25" — Excel
// guesses the current year, which silently changes meaning in January); a
// one- or three-digit year ("1-2-3" is a part number far more often than it is
// a date, and typing the year in full is the escape hatch); a non-year-first
// numeric date in a locale whose short date IS year-first (nothing in the
// regional settings says whether "6/1/2020" is June or January there); an
// impossible calendar day ("2020-02-31"); a year before 1900 or after 9999;
// elapsed times past 23:59:59 ("36:00"); and month names from any language but
// the locale's own.

/// The three characters a numeric date may be written with. One entry must use
/// exactly one of them — "2020-06/01" is not a date.
const DATE_SEPARATORS: [char; 3] = ['-', '/', '.'];

/// Which order the locale writes a NUMERIC date in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortDateOrder {
    Ymd,
    Dmy,
    Mdy,
}

/// Read the locale's numeric date order off `LocaleSettings::date_format`.
///
/// The struct carries no dedicated order field; that pattern ("MM/DD/YYYY",
/// "DD.MM.YYYY", "YYYY-MM-DD") is the only thing in it that says whether
/// `06/01/2020` is June 1st or January 6th.
fn locale_short_date_order(locale: &crate::LocaleSettings) -> ShortDateOrder {
    let pattern = locale.date_format.to_ascii_uppercase();
    match (pattern.find('Y'), pattern.find('M'), pattern.find('D')) {
        (Some(y), Some(m), Some(d)) if y < m && y < d => ShortDateOrder::Ymd,
        (Some(_), Some(m), Some(d)) if d < m => ShortDateOrder::Dmy,
        (Some(_), Some(_), Some(_)) => ShortDateOrder::Mdy,
        // An unreadable pattern is treated as year-first, which is the arm that
        // REFUSES an ambiguous entry instead of guessing at it.
        _ => ShortDateOrder::Ymd,
    }
}

/// Excel's two-digit-year window for TYPED text: 00-29 is 2000-2029, 30-99 is
/// 1930-1999.
///
/// THE ENGINE DOES NOT OWN THIS RULE — `date_serial.rs` has no year window at
/// all, and the two-digit rule the engine does implement is a DIFFERENT one:
/// `fn_date` in `evaluator.rs` adds 1900 to a small YEAR ARGUMENT, because that
/// is what Excel's `DATE(99,1,1)` does. Expressing typed dates in terms of that
/// rule would date every `.../20` entry to 1920.
fn expand_two_digit_year(yy: i32) -> i32 {
    if yy <= 29 {
        2000 + yy
    } else {
        1900 + yy
    }
}

/// A month, day, hour, minute or second component: one or two ASCII digits.
fn parse_two_digit_component(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 2 || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok()
}

/// A year component: four digits as written, two digits through Excel's window.
/// One and three digits are refused — see the REFUSED list above.
fn parse_year_component(text: &str) -> Option<i32> {
    if !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    match text.len() {
        4 => text.parse::<i32>().ok(),
        2 => text.parse::<i32>().ok().map(expand_two_digit_year),
        _ => None,
    }
}

/// Is this a date Excel can hold, on a calendar that exists?
///
/// `date_to_serial` validates NOTHING: it normalizes month overflow and adds
/// the day straight in, so `2020-02-31` returns the serial for March 2nd — a
/// SILENTLY WRONG date, not an error. The calendar check has to happen here,
/// before the conversion.
fn valid_ymd(year: i32, month: u32, day: u32) -> bool {
    if !(1900..=9999).contains(&year) || !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    // Excel's phantom 1900-02-29 (serial 60) is a real date to Excel and to
    // `date_to_serial`, which uses the Lotus leap rule; `days_in_month` gives
    // the honest Gregorian 28. This is the one date where they disagree, and
    // Excel accepts it, so it is spelled out rather than rejected.
    if year == 1900 && month == 2 && day == 29 {
        return true;
    }
    day <= crate::date_serial::days_in_month(year, month)
}

/// Split a typed entry into its date part and its time part.
///
/// The split point is the separator immediately before the first ':' — the
/// space of "2020-06-01 13:45" or the 'T' of "2020-06-01T13:45:00". An entry
/// with no ':' is all date; a ':' with nothing usable before it is all time.
/// 'T' only splits when a DIGIT precedes it, so the 't' inside a month name
/// (and inside "Meeting: 5") never cuts an entry in half.
fn split_date_and_time(text: &str) -> (Option<&str>, Option<&str>) {
    let colon = match text.find(':') {
        Some(i) => i,
        None => return (Some(text), None),
    };
    let head = &text[..colon];
    let boundary = head.char_indices().rev().find(|&(i, c)| {
        c.is_whitespace()
            || ((c == 'T' || c == 't')
                && head[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|prev| prev.is_ascii_digit()))
    });
    match boundary {
        Some((i, c)) => {
            let date = text[..i].trim();
            let time = text[i + c.len_utf8()..].trim();
            if date.is_empty() {
                (None, Some(time))
            } else {
                (Some(date), Some(time))
            }
        }
        None => (None, Some(text)),
    }
}

/// Parse a numeric date ("2020-06-01", "01.06.2020", "6/1/20").
fn parse_numeric_date(text: &str, locale: &crate::LocaleSettings) -> Option<(i32, u32, u32)> {
    let separator = text.chars().find(|c| DATE_SEPARATORS.contains(c))?;
    if text
        .chars()
        .any(|c| DATE_SEPARATORS.contains(&c) && c != separator)
    {
        return None;
    }
    let parts: Vec<&str> = text.split(separator).collect();
    // THREE components or nothing. "3/4" is a fraction, a score, a part number
    // or March 4th depending on who typed it, and Excel's answer (the current
    // year) changes meaning every New Year's Day.
    if parts.len() != 3 {
        return None;
    }
    if parts
        .iter()
        .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    // A four-digit LEADING component is a year in every locale: no short-date
    // pattern anywhere starts with a four-digit day or month.
    let (year_text, month_text, day_text) = if parts[0].len() == 4 {
        (parts[0], parts[1], parts[2])
    } else {
        match locale_short_date_order(locale) {
            ShortDateOrder::Mdy => (parts[2], parts[0], parts[1]),
            ShortDateOrder::Dmy => (parts[2], parts[1], parts[0]),
            // The locale's short date is year-first (sv-SE "YYYY-MM-DD") and
            // this entry is not, so the regional settings say nothing about
            // whether "6/1/2020" is June 1st or January 6th. Refuse.
            ShortDateOrder::Ymd => return None,
        }
    };
    let year = parse_year_component(year_text)?;
    let month = parse_two_digit_component(month_text)?;
    let day = parse_two_digit_component(day_text)?;
    if !valid_ymd(year, month, day) {
        return None;
    }
    Some((year, month, day))
}

/// Match a token against the LOCALE's month names — the same table the
/// custom-format engine renders `mmm`/`mmmm` from. A trailing '.' is ignored on
/// both sides, because several locales abbreviate as "jan." and the tokenizer
/// has already split that dot off.
fn month_index(calendar: &crate::CalendarNames, token: &str) -> Option<u32> {
    let needle = token.trim_end_matches('.').to_lowercase();
    if needle.is_empty() {
        return None;
    }
    for m in 0..12usize {
        for name in [calendar.months_full[m], calendar.months_short[m]] {
            let name = name.trim_end_matches('.');
            // Length prefilter before the case fold: this runs on every
            // three-token text cell of a paste, and 24 `to_lowercase`
            // allocations per token would be paid for by every "Total sales
            // 2020" in the clipboard.
            if name.len() == needle.len() && name.to_lowercase() == needle {
                return Some(m as u32 + 1);
            }
        }
    }
    None
}

/// Parse a date written with a month NAME ("1 Jun 2020", "Jun 1, 2020",
/// "1. juni 2020"). The name makes the order unambiguous, so both arrangements
/// are safe — but only in the locale's own language, since accepting every
/// language's names would make one locale's month collide with another's word.
fn parse_month_name_date(text: &str, locale: &crate::LocaleSettings) -> Option<(i32, u32, u32)> {
    let calendar = locale.calendar();
    let tokens: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c == ',' || c == '.' || c == '-' || c == '/')
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() != 3 {
        return None;
    }
    let month_at = tokens
        .iter()
        .position(|t| month_index(calendar, t).is_some())?;
    let month = month_index(calendar, tokens[month_at])?;
    let (day_text, year_text) = match month_at {
        0 => (tokens[1], tokens[2]), // "Jun 1, 2020"
        1 => (tokens[0], tokens[2]), // "1 Jun 2020"
        _ => return None,            // nobody writes "1 2020 Jun"
    };
    let day = parse_two_digit_component(day_text)?;
    let year = parse_year_component(year_text)?;
    if !valid_ymd(year, month, day) {
        return None;
    }
    Some((year, month, day))
}

fn parse_date_part(text: &str, locale: &crate::LocaleSettings) -> Option<(i32, u32, u32)> {
    parse_numeric_date(text, locale).or_else(|| parse_month_name_date(text, locale))
}

/// Parse a clock time into a fraction of a day, and report whether SECONDS were
/// typed — the caller picks the short or the long time pattern from that.
fn parse_clock_time(text: &str, locale: &crate::LocaleSettings) -> Option<(f64, bool)> {
    let upper = text.to_ascii_uppercase();
    // AM/PM only where the locale HAS a meridiem: sv-SE's time pattern is
    // "hh:mm:ss" with no designator, so "1:45 PM" is not a Swedish time.
    let locale_has_meridiem = locale.time_format.to_ascii_uppercase().contains("AM/PM");
    let (body, pm) = if let Some(rest) = upper.trim().strip_suffix("PM") {
        (rest.trim_end(), Some(true))
    } else if let Some(rest) = upper.trim().strip_suffix("AM") {
        (rest.trim_end(), Some(false))
    } else {
        (upper.trim(), None)
    };
    if pm.is_some() && !locale_has_meridiem {
        return None;
    }
    let parts: Vec<&str> = body.split(':').collect();
    // A bare "13" is the NUMBER 13 and never reaches here, so a time needs at
    // least hours and minutes.
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let hour_typed = parse_two_digit_component(parts[0])?;
    let minute = parse_two_digit_component(parts[1])?;
    let second = match parts.get(2) {
        Some(s) => parse_two_digit_component(s)?,
        None => 0,
    };
    if minute > 59 || second > 59 {
        return None;
    }
    let hour = match pm {
        // 12-hour clock: 12 AM is midnight, 12 PM is noon.
        Some(true) => match hour_typed {
            12 => 12,
            1..=11 => hour_typed + 12,
            _ => return None,
        },
        Some(false) => match hour_typed {
            12 => 0,
            1..=11 => hour_typed,
            _ => return None,
        },
        // 24-hour clock. Excel would also take "36:00" as an ELAPSED time and
        // format it `[h]:mm`; that is a third format decision, so hours past 23
        // stay text here.
        None => {
            if hour_typed > 23 {
                return None;
            }
            hour_typed
        }
    };
    let seconds_of_day = hour as f64 * 3600.0 + minute as f64 * 60.0 + second as f64;
    Some((seconds_of_day / 86400.0, parts.len() == 3))
}

/// The time pattern a typed time implies. Excel shows what you typed: no
/// seconds typed, no seconds displayed — so the locale's long time pattern
/// (which always carries `ss`, see `LocaleSettings::time_format`) loses its
/// seconds field for a "13:45".
fn implied_time_pattern(locale: &crate::LocaleSettings, had_seconds: bool) -> String {
    if had_seconds {
        return locale.time_format.clone();
    }
    let lowered = locale.time_format.to_ascii_lowercase();
    match lowered.find(":ss") {
        Some(pos) => {
            let mut short = locale.time_format.clone();
            short.replace_range(pos..pos + 3, "");
            short
        }
        None => locale.time_format.clone(),
    }
}

/// The format a typed percentage implies: "50%" is `0%`, "12.5%" is `0.0%`.
/// Returns `None` for anything that is not a percentage, which is what makes it
/// safe to call on every number the parser accepts.
fn implied_percentage_format(text: &str, locale: &crate::LocaleSettings) -> Option<NumberFormat> {
    let trimmed = text.trim();
    // EITHER END. The shared number parser reads a percent sign on either side
    // (`"%5"` is 0.05, as in Excel), and a rung that only recognised the
    // trailing one would store 0.05 under `General` and DISPLAY "0.05" — the
    // percent the user typed silently gone from a cell that is nonetheless a
    // percentage. Recognising only what the parser accepts is what keeps the
    // value and its format one decision.
    let body = match trimmed.strip_suffix('%') {
        Some(body) => body.trim_end(),
        None => trimmed.strip_prefix('%')?.trim_start(),
    };
    let decimals = match body.rsplit_once(locale.decimal_separator) {
        Some((_, fraction)) => fraction.chars().filter(|c| c.is_ascii_digit()).count(),
        None => 0,
    };
    Some(NumberFormat::Percentage {
        // Excel's own ceiling for decimal places in a format.
        decimal_places: decimals.min(30) as u8,
    })
}

/// Recognise a typed date, time, or date and time, and return the Excel serial
/// together with the number format the entry implies.
/// PUBLIC for the same reason as [`parse_number`]: it is the date half of the
/// same primitive, and the suite that pins the calendar edge cases calls it by
/// name.
pub fn parse_date_time_input(
    text: &str,
    locale: &crate::LocaleSettings,
) -> Option<(f64, NumberFormat)> {
    let (date_text, time_text) = split_date_and_time(text);
    let date = match date_text {
        Some(d) => Some(parse_date_part(d, locale)?),
        None => None,
    };
    let time = match time_text {
        Some(t) => Some(parse_clock_time(t, locale)?),
        None => None,
    };
    match (date, time) {
        (Some((y, m, d)), None) => Some((
            crate::date_serial::date_to_serial(y, m as i32, d as i32),
            NumberFormat::Date {
                format: locale.date_format.clone(),
            },
        )),
        (None, Some((fraction, had_seconds))) => Some((
            fraction,
            NumberFormat::Time {
                format: implied_time_pattern(locale, had_seconds),
            },
        )),
        (Some((y, m, d)), Some((fraction, had_seconds))) => Some((
            crate::date_serial::date_to_serial(y, m as i32, d as i32) + fraction,
            // A combined value is a DATE format that carries time tokens, the
            // way Excel's own "m/d/yyyy h:mm" is. The custom-format engine
            // resolves the m/mm ambiguity by adjacency, so the `MM` after the
            // year stays a month and the one after `hh` becomes minutes.
            NumberFormat::Date {
                format: format!(
                    "{} {}",
                    locale.date_format,
                    implied_time_pattern(locale, had_seconds)
                ),
            },
        )),
        (None, None) => None,
    }
}
