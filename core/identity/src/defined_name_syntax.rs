//! FILENAME: core/identity/src/defined_name_syntax.rs
//! PURPOSE: Whether a string is a name Excel accepts as a DEFINED NAME (and so
//!          as a table name, which shares the namespace) -- the one rule every
//!          door asks: the Name Manager and the table commands in the app, and
//!          the `.calp` publish and pull doors, which cannot reach the app crate.
//! CONTEXT: Moved here from `NamedRange::is_valid_name` (app/src-tauri/src/
//!          named_ranges.rs, which now delegates) so a package's names are
//!          judged by exactly the rule the subscriber's own UI applies. A copy
//!          in core/calp would drift from the app's on the first live probe
//!          that tightened one of them.

/// Excel's longest defined name [LIVE, Excel 16, 2026-11-05: 255 characters
/// accepted, 256 refused].
pub const MAX_DEFINED_NAME_CHARS: usize = 255;

/// A run of ASCII digits read as a number in `1..=max`, leading zeros allowed
/// (Excel reads `A01` and `R01` as row 1). `None` for 0, for an empty run, and
/// past `max` -- never an overflow, whatever the length of the run.
fn digits_in_range(digits: &str, max: u32) -> Option<u32> {
    let significant = digits.trim_start_matches('0');
    if digits.is_empty() || significant.is_empty() || significant.len() > 10 {
        return None;
    }
    let n: u64 = significant.parse().ok()?;
    (n >= 1 && n <= u64::from(max)).then_some(n as u32)
}

/// The length of the leading run of ASCII digits in `s`.
fn leading_digits(s: &str) -> usize {
    s.bytes().take_while(|b| b.is_ascii_digit()).count()
}

/// Whether `name` is a name Excel would accept as a defined name.
///
/// Characters [`is_valid_table_name`]'s, plus one rule of a defined name's
/// own: a name that begins with a backslash is `\` alone or at least three
/// characters long [LIVE, Excel 16, 2026-11-06, lane names q2.ps1 + q3.ps1:
/// `\`, `\ab`, `\a1`, `\_a`, `\1a`, `\.a`, `\?a`, `\\a`, `\11`, `\RC`,
/// `\A1`, `\TRUE`, `\R1C1` are names; `\a`, `\A`, `\b`, `\x`, `\_`, `\.`,
/// `\1`, `\?`, `\\` are refused -- while a TABLE may be named `\a` (q4.ps1)].
///
/// Refused because it reads as a reference or a constant [LIVE, Excel 16
/// build 20326, 2026-11-05, miscb-probe1..4.ps1, `Names.Add` per name]:
/// - an A1 cell (`A1`, `a1`, `XFD1048576`, `A01`) -- `XFE1`, `A0` and
///   `A1048577` are past the sheet and are names;
/// - an R1C1 reference: `R`, `C`, `RC` exactly, and any name that BEGINS
///   with `R<row>` / `C<col>` / `RC<col>` (row 1-1048576, column 1-16384,
///   leading zeros allowed) unless a period follows the number -- so
///   `R1C1`, `R2C3`, `RC1`, `R1C`, `R1x`, `C5_`, `R5C0` are refused while
///   `R0C0`, `RC0`, `R1048577`, `RCX`, `RC_`, `R1.x`, `C1.` are names;
/// - a Lotus-style range `A1.B1` / `A1..B1`: an A1 cell, periods, and an A1
///   cell again (`A1.B1x`, `A1.R1C1`, `x.A1.B1` are names);
/// - `TRUE` and `FALSE` in any case (`NULL` is a name in Excel).
pub fn is_valid_defined_name(name: &str) -> bool {
    if name.starts_with('\\') && name.chars().count() == 2 {
        return false;
    }
    is_valid_table_name(name)
}

/// Whether `name` is a name Excel would accept as a TABLE name: the defined
/// name's rule without its two-character backslash refusal
/// ([`is_valid_defined_name`]; [LIVE, Excel 16, 2026-11-06, lane names
/// q4.ps1: `ListObject.Name` takes `\abc`, `a\b`, `abc?`, `\`, `\a`, `_x`,
/// `a?b`, `\ab`]).
///
/// Characters: a letter, underscore or BACKSLASH first; then letters,
/// digits, underscores, periods, backslashes and question marks; at most
/// [`MAX_DEFINED_NAME_CHARS`] of them [LIVE, q1-q3.ps1: `\abc`, `a\b`,
/// `abc?`, `a?b`, `_?`, `a\`, `a?.b` are names, `?abc`, `?`, `.a`, `1a`,
/// `\a b` are not; `=\abc`, `=a\b`, `=abc?`, `=\` read the names]. A name
/// that begins with a backslash is never a reference (`\A1`, `\R1C1`,
/// `\TRUE` are names), and one that holds a `?` or `\` is no A1 cell or
/// Lotus range (`A1?`, `A1.B1?`, `TRUE?` are names) -- but the R1C1 prefix
/// rule reads past them (`R1?`, `C1\`, `RC1?` are refused, `R?` and `C\`
/// are names).
pub fn is_valid_table_name(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > MAX_DEFINED_NAME_CHARS {
        return false;
    }

    let mut chars = name.chars();

    // First character must be a letter, an underscore or a backslash.
    let leading_backslash = match chars.next() {
        Some('\\') => true,
        Some(c) if c.is_alphabetic() || c == '_' => false,
        _ => return false,
    };

    // Remaining characters: letters, digits, underscore, period, backslash,
    // question mark.
    for c in chars {
        if !c.is_alphanumeric() && !matches!(c, '_' | '.' | '\\' | '?') {
            return false;
        }
    }
    if leading_backslash {
        return true;
    }

    // Cannot be a valid cell reference (like A1, B2, etc.)
    if looks_like_a1_cell(name) {
        return false;
    }

    // Cannot read as an R1C1 reference, or as a Lotus-style A1.B1 range.
    if looks_like_r1c1_reference(name) || looks_like_dotted_range(name) {
        return false;
    }

    // Cannot be TRUE or FALSE (ASCII case fold: a name is never folded
    // into ASCII from elsewhere).
    let upper = name.to_ascii_uppercase();
    if upper == "TRUE" || upper == "FALSE" {
        return false;
    }

    true
}

/// Excel's R1C1 refusal (see [`is_valid_defined_name`]): `R`, `C` and `RC`
/// exactly, or a name that BEGINS with `R<row>`, `C<col>` or `RC<col>`
/// where the number is a real row (1-1048576) or column (1-16384) and is
/// not followed by a period. ASCII case-insensitive.
fn looks_like_r1c1_reference(s: &str) -> bool {
    let upper = s.to_ascii_uppercase();
    if upper == "R" || upper == "C" || upper == "RC" {
        return true;
    }
    // The text after a leading number, if that number is a real one.
    let after_number = |rest: &str, max: u32| -> Option<String> {
        let n = leading_digits(rest);
        digits_in_range(&rest[..n], max).map(|_| rest[n..].to_string())
    };
    let refuses = |tail: Option<String>| matches!(tail, Some(t) if !t.starts_with('.'));
    if let Some(rest) = upper.strip_prefix("RC") {
        if refuses(after_number(rest, 16384)) {
            return true;
        }
    }
    if let Some(rest) = upper.strip_prefix('R') {
        if refuses(after_number(rest, 1_048_576)) {
            return true;
        }
    }
    if let Some(rest) = upper.strip_prefix('C') {
        if refuses(after_number(rest, 16384)) {
            return true;
        }
    }
    false
}

/// Excel's Lotus-range refusal: an A1 cell, one or more periods, then an
/// A1 cell that ends the name or is followed by a period (`A1.B1`,
/// `A1..B1`, `A1.B1.x`). `A1.B1x` and `A1.R1C1` are names.
fn looks_like_dotted_range(s: &str) -> bool {
    let Some(dot) = s.find('.') else { return false };
    if !looks_like_a1_cell(&s[..dot]) {
        return false;
    }
    let rest = s[dot..].trim_start_matches('.');
    let second = rest.split('.').next().unwrap_or("");
    !second.is_empty() && looks_like_a1_cell(second)
}

/// Whether a string reads as an A1 cell (e.g., A1, BC123): columns A-XFD
/// (1-16384), rows 1-1048576.
pub fn looks_like_a1_cell(s: &str) -> bool {
    // ASCII fold only: `to_uppercase` expands `ß` to `SS`, which turned the
    // name `ß1` into the cell SS1 (Excel accepts `ß1` [LIVE]).
    let upper = s.to_ascii_uppercase();
    let bytes = upper.as_bytes();

    // Find where letters end and digits begin
    let mut letter_end = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if b.is_ascii_uppercase() {
            letter_end = i + 1;
        } else {
            break;
        }
    }

    // Must have at least one letter
    if letter_end == 0 {
        return false;
    }

    // Must have at least one digit after the letters
    if letter_end >= bytes.len() {
        return false;
    }

    // All remaining characters must be digits
    for &b in &bytes[letter_end..] {
        if !b.is_ascii_digit() {
            return false;
        }
    }

    // Convert column letters to column number (A=1, B=2, ..., Z=26, AA=27, etc.)
    //
    // The ceiling is enforced INSIDE the loop, and that placement is the whole
    // point. This ran the multiplication to the end of the letter run and only
    // then compared against 16384 — so a name like "ABCDEFGHIJKLMNOP1"
    // overflowed `u32` first. In a debug build that is a panic, and this
    // function is reached from a `#[tauri::command]` on a thread that cannot
    // unwind, so the panic ABORTED THE WHOLE APPLICATION
    // (STATUS_STACK_BUFFER_OVERRUN) rather than rejecting the name. A user
    // typing a long alphabetic name that ends in digits could kill the app and
    // lose the workbook.
    //
    // Bailing at the ceiling also makes overflow unreachable by construction:
    // `col_num` is at most 16384 on entry to each multiply, so the largest
    // value the arithmetic can produce is 16384 * 26 + 26 = 426,010.
    let col_str = &upper[..letter_end];
    let mut col_num: u32 = 0;
    for c in col_str.chars() {
        col_num = col_num * 26 + (c as u32 - 'A' as u32 + 1);
        // Excel max column is XFD = 16384. Past it, this is not a cell
        // reference and no further digits can bring it back.
        if col_num > 16384 {
            return false;
        }
    }

    // Parse the row number
    let row_str = &upper[letter_end..];
    if let Ok(row_num) = row_str.parse::<u32>() {
        // Row must be between 1 and 1048576
        row_num >= 1 && row_num <= 1048576
    } else {
        false
    }
}
