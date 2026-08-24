//! FILENAME: core/engine/src/text_character_semantics_tests.rs
//! PURPOSE: The text functions count CHARACTERS, not bytes — LEN, FIND and
//!          SEARCH, and the siblings that were already right.
//!
//! WHY THIS FILE EXISTS AND WHY IT MATTERS HERE MORE THAN ELSEWHERE. Rust's
//! `str::len()` is a BYTE count, and reaching for it is the natural mistake
//! because in ASCII it gives the right answer. Calcula ships Swedish by
//! default: å, ä and ö are two bytes each in UTF-8, so the defect did not wait
//! for an exotic input — it fired on ordinary Swedish words, on the first
//! workbook, silently.
//!
//! THREE DISTINCT FAILURES WERE FOUND, and only the first was known:
//!
//!   * `=LEN("åäö")` answered 6 instead of 3. A plausible number on the cell,
//!     no error, and wrong by exactly the factor that makes text-slicing
//!     arithmetic look almost right.
//!   * `=FIND("ö";"åäö")` answered 5 instead of 3 — a BYTE position handed to
//!     the user as a character position. This is worse than LEN because FIND's
//!     entire purpose is to feed MID/LEFT/REPLACE, which count CHARACTERS, so
//!     the two halves of the standard idiom disagreed and produced a wrong
//!     STRING rather than a wrong number.
//!   * `=FIND("ö";"åäö";2)` and `=SEARCH("?ö";"åäö")` PANICKED. `start` was used
//!     as a byte offset in `within_text[start..]`, and slicing a `str` at a
//!     non-character boundary is a panic, not an error value. That is an
//!     evaluator crash reachable from a formula bar.
//!
//! THE CONTROLS ARE THE POINT OF THE FILE. LEFT/RIGHT/MID/REPLACE/SUBSTITUTE/
//! TRIM/REPT/TEXTBEFORE/TEXTAFTER were MEASURED and were already character-
//! correct. They are asserted here anyway, next to the broken ones, because
//! they are what LEN and FIND have to agree with: a "fix" that moved everything
//! to bytes would be self-consistent and completely wrong, and only a test that
//! pins both halves can tell those two worlds apart.
//!
//! EVERY CASE USES A STRING WHOSE BYTE AND CHARACTER LENGTHS DIFFER. An ASCII
//! fixture cannot fail any of these assertions.

use crate::cell::CellError;
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn eval(formula: &str) -> EvalResult {
    let grid = Grid::new();
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(&grid).evaluate(&ast)
}

fn num(formula: &str) -> f64 {
    match eval(formula) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` gave {:?}, expected a number", formula, other),
    }
}

fn text(formula: &str) -> String {
    match eval(formula) {
        EvalResult::Text(t) => t,
        other => panic!("`{}` gave {:?}, expected text", formula, other),
    }
}

// ===================================================================
// LEN
// ===================================================================

/// THE DEFECT: `EvalResult::Number(text.len() as f64)` — a byte count.
#[test]
fn len_counts_characters_not_bytes() {
    // "é" is one character in two bytes. This answered 2.
    assert_eq!(num("=LEN(\"é\")"), 1.0);
    // The whole Swedish trio: three characters, six bytes. This answered 6.
    assert_eq!(num("=LEN(\"åäö\")"), 3.0);
    // Concatenation does not launder it: two characters, four bytes.
    assert_eq!(num("=LEN(\"é\"&\"é\")"), 2.0);
    // Mixed ASCII and non-ASCII, where the error is a partial one and so the
    // easiest to miss in review: 4 characters, 6 bytes.
    assert_eq!(num("=LEN(\"Åke!\")"), 4.0);
    // A 3-byte character (CJK) and a 4-byte one (astral plane), so a fix that
    // assumed "2 bytes per non-ASCII character" cannot pass.
    assert_eq!(num("=LEN(\"日本\")"), 2.0);
    assert_eq!(num("=LEN(\"😀\")"), 1.0);

    // CONTROL: pure ASCII, where bytes and characters agree. Without this an
    // implementation that returned some other wrong number could pass above.
    assert_eq!(num("=LEN(\"abc\")"), 3.0);
    assert_eq!(num("=LEN(\"\")"), 0.0);
}

/// THE IDIOM THE BUG BROKE, asserted as one expression rather than as two
/// separate facts, because the defect was precisely that the two halves
/// disagreed.
#[test]
fn len_agrees_with_left_and_right_about_the_same_string() {
    // "drop the last character" — the single commonest use of LEN. With a byte
    // count, LEN("Åke")-1 was 3, so LEFT was asked for 3 characters of a
    // 3-character string and dropped NOTHING: the formula silently did nothing.
    assert_eq!(text("=LEFT(\"Åke\",LEN(\"Åke\")-1)"), "Åk");
    // And the mirror: "everything but the first character".
    assert_eq!(text("=RIGHT(\"Åke\",LEN(\"Åke\")-1)"), "ke");
    // MID over the whole string must reproduce it exactly.
    assert_eq!(text("=MID(\"åäö\",1,LEN(\"åäö\"))"), "åäö");
}

// ===================================================================
// FIND and SEARCH — position AND the crash
// ===================================================================

/// THE DEFECT: the returned position was a BYTE offset.
#[test]
fn find_and_search_return_character_positions() {
    // "ö" is the 3rd CHARACTER of "åäö" but starts at BYTE 4. Both answered 5.
    assert_eq!(num("=FIND(\"ö\",\"åäö\")"), 3.0);
    assert_eq!(num("=SEARCH(\"ö\",\"åäö\")"), 3.0);
    // The first character is position 1 either way — the case that made the bug
    // invisible in casual testing.
    assert_eq!(num("=FIND(\"å\",\"åäö\")"), 1.0);
    // A multi-character needle, and an ASCII needle after non-ASCII text: the
    // "!" is character 4, byte 7.
    assert_eq!(num("=FIND(\"!\",\"åäö!\")"), 4.0);
    assert_eq!(num("=FIND(\"äö\",\"åäö\")"), 2.0);

    // CONTROL: pure ASCII, where the old byte answer was already correct. A fix
    // that shifted every position by some constant would fail here.
    assert_eq!(num("=FIND(\"c\",\"abc\")"), 3.0);
    assert_eq!(num("=SEARCH(\"C\",\"abc\")"), 3.0, "SEARCH is case-insensitive");
    // Not found is #VALUE!, not position 0 — unchanged, and asserted so the
    // rewrite cannot have turned a miss into a hit.
    assert_eq!(eval("=FIND(\"z\",\"åäö\")"), EvalResult::Error(CellError::Value));
    assert_eq!(eval("=SEARCH(\"z\",\"åäö\")"), EvalResult::Error(CellError::Value));
}

/// THE CRASH. `start_num` is a CHARACTER index and was used as a BYTE offset,
/// so `within_text[start..]` sliced through the middle of a multi-byte
/// character and PANICKED — taking the evaluator down rather than returning any
/// error value at all. Reachable by typing a formula.
#[test]
fn find_with_a_start_position_does_not_panic_on_multibyte_text() {
    // start_num = 2 is byte 1, which is inside 'å'. This panicked with
    // "byte index 1 is not a char boundary".
    assert_eq!(num("=FIND(\"ö\",\"åäö\",2)"), 3.0);
    // Starting exactly ON the match still finds it.
    assert_eq!(num("=FIND(\"ä\",\"åäö\",2)"), 2.0);
    // Starting PAST the match does not: the search is forward-only, so this is
    // a miss rather than a wrap-around.
    assert_eq!(eval("=FIND(\"å\",\"åäö\",2)"), EvalResult::Error(CellError::Value));
    // Repeated needle: start_num is what picks the SECOND occurrence, which is
    // the reason the argument exists.
    assert_eq!(num("=FIND(\"ä\",\"äXä\",2)"), 3.0);
    // One past the end is a legal start (empty remainder), not a panic.
    assert_eq!(eval("=FIND(\"å\",\"åäö\",4)"), EvalResult::Error(CellError::Value));
    // Beyond that is #VALUE!, as it always was for the ASCII case.
    assert_eq!(eval("=FIND(\"å\",\"åäö\",9)"), EvalResult::Error(CellError::Value));

    // CONTROL: the same shape in ASCII, which never panicked and must not have
    // changed meaning.
    assert_eq!(num("=FIND(\"b\",\"abcb\",3)"), 4.0);
}

/// SEARCH's WILDCARD branch walks positions in its own loop, so it had a second
/// copy of the same crash — `within_text[pos..]` over a byte range.
#[test]
fn search_with_wildcards_does_not_panic_on_multibyte_text() {
    // `?ö` = "any one character, then ö". Matches at character 2 ("äö").
    // This panicked at the very first non-ASCII boundary.
    assert_eq!(num("=SEARCH(\"?ö\",\"åäö\")"), 2.0);
    // A leading `*` matches at position 1.
    assert_eq!(num("=SEARCH(\"*ö\",\"åäö\")"), 1.0);
    // A lone `?` matches the first character, not the last — the prefix-match
    // property an earlier fix established, re-asserted over multibyte text
    // because the boundary walk is what now produces the index.
    assert_eq!(num("=SEARCH(\"?\",\"åäö\")"), 1.0);
    // A wildcard match landing on a LATER character reports that character's
    // position, not its byte offset. "ö!" is at character 3.
    assert_eq!(num("=SEARCH(\"?!\",\"åäö!\")"), 3.0);
    // No match is still #VALUE!.
    assert_eq!(eval("=SEARCH(\"?z\",\"åäö\")"), EvalResult::Error(CellError::Value));

    // CONTROL: ASCII wildcards, whose answers were already right.
    assert_eq!(num("=SEARCH(\"a*c\",\"xabcy\")"), 2.0);
    assert_eq!(num("=SEARCH(\"?\",\"abc\")"), 1.0);
}

/// FIND feeding MID/LEFT/RIGHT is the reason a byte position was worse than a
/// wrong number: the two functions counted in different units, so the composed
/// formula returned a mangled STRING with no error anywhere.
#[test]
fn find_composes_with_mid_and_left_over_multibyte_text() {
    // "split on the separator" — the canonical use. With FIND answering a byte
    // position, LEFT was handed 3 instead of 1 and returned "åXä" whole.
    assert_eq!(text("=LEFT(\"åXäö\",FIND(\"X\",\"åXäö\")-1)"), "å");
    assert_eq!(
        text("=MID(\"åXäö\",FIND(\"X\",\"åXäö\")+1,99)"),
        "äö"
    );
    // The same over a Swedish sentence with an ASCII separator, which is what
    // this actually looks like in a workbook.
    assert_eq!(text("=LEFT(\"Åke Ödman\",FIND(\" \",\"Åke Ödman\")-1)"), "Åke");
    assert_eq!(text("=MID(\"Åke Ödman\",FIND(\" \",\"Åke Ödman\")+1,99)"), "Ödman");
}

// ===================================================================
// The siblings that were ALREADY character-correct
// ===================================================================

/// MEASURED CORRECT BEFORE THE FIX, and pinned so they stay that way.
///
/// These are the reason LEN's byte count was a contradiction rather than merely
/// a wrong convention: the engine had already decided, everywhere else, that
/// text is measured in characters. They also form the control set for the
/// direction of the fix — if a later change moved the engine to bytes, these
/// fail before LEN does.
#[test]
fn the_character_correct_text_functions_stay_character_correct() {
    assert_eq!(text("=LEFT(\"åäö\",1)"), "å");
    assert_eq!(text("=LEFT(\"åäö\",2)"), "åä");
    assert_eq!(text("=RIGHT(\"åäö\",1)"), "ö");
    assert_eq!(text("=RIGHT(\"åäö\",2)"), "äö");
    assert_eq!(text("=MID(\"åäö\",2,1)"), "ä");
    assert_eq!(text("=MID(\"åäö\",2,2)"), "äö");
    // REPLACE takes BOTH a start and a length in characters.
    assert_eq!(text("=REPLACE(\"åäö\",2,1,\"X\")"), "åXö");
    assert_eq!(text("=REPLACE(\"åäö\",1,2,\"X\")"), "Xö");
    assert_eq!(text("=SUBSTITUTE(\"åäö\",\"ä\",\"X\")"), "åXö");
    assert_eq!(text("=REPT(\"å\",3)"), "ååå");
    assert_eq!(text("=TEXTBEFORE(\"åXä\",\"X\")"), "å");
    assert_eq!(text("=TEXTAFTER(\"åXä\",\"X\")"), "ä");
    // TRIM measured through LEN, which is the composition that was wrong.
    assert_eq!(num("=LEN(TRIM(\" åäö \"))"), 3.0);
    // UPPER/LOWER must not change the character COUNT for these letters.
    assert_eq!(num("=LEN(UPPER(\"åäö\"))"), 3.0);
    assert_eq!(num("=LEN(LOWER(\"ÅÄÖ\"))"), 3.0);
}

/// LEN over a NUMBER goes through the same coercion, so the character count has
/// to survive it. A locale that renders a decimal comma is still one character
/// per glyph.
#[test]
fn len_of_a_coerced_value_is_still_a_character_count() {
    assert_eq!(num("=LEN(12345)"), 5.0);
    assert_eq!(num("=LEN(TRUE)"), 4.0);
    // AN ERROR IS NOT MEASURED AT ALL — it propagates.
    //
    // THIS ASSERTION USED TO READ `assert_eq!(num("=LEN(1/0)"), 7.0)` with the
    // note "#DIV/0! is seven characters". That was the character count of an
    // error's LITERAL SPELLING, and counting it was the whole defect: the
    // number 7 is a perfectly plausible length, so a `#DIV/0!` upstream
    // arrived downstream as data. Excel propagates the error out of every text
    // function; see `error_propagation_tests.rs`.
    assert_eq!(
        eval("=LEN(1/0)"),
        EvalResult::Error(CellError::Div0),
        "an error argument propagates out of LEN, it is not measured"
    );
}
