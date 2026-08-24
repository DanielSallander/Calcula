//! FILENAME: core/engine/src/formula_locale.rs
//! PURPOSE: Translates formula strings between locale format and invariant (US) format.
//! CONTEXT: Formulas are always stored internally in invariant format (decimal: '.',
//!          list separator: ','). This module converts at the input/output boundary:
//!          - delocalize: user input (locale) -> storage (invariant)
//!          - localize: storage (invariant) -> display (locale)

use crate::locale::LocaleSettings;

/// Convert a formula from locale format to invariant (US) format for internal storage.
///
/// Example (sv-SE): `=SUMMA(A1;B1;1,5)` -> `=SUMMA(A1,B1,1.5)`
///
/// When `list_separator` is ';':
///   - ';' -> ',' (argument separator)
///   - ',' -> '.' (decimal separator)
/// When `list_separator` is ',': no translation needed.
pub fn delocalize_formula(input: &str, locale: &LocaleSettings) -> String {
    if locale.list_separator == ',' && locale.decimal_separator == '.' {
        // Already invariant format
        return input.to_string();
    }

    let mut result = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut in_string = false;
    let mut sheet_name = SheetNameSpan::new();
    let mut braces = BraceStack::new();

    while i < len {
        let ch = chars[i];

        // A `"` only opens a string literal OUTSIDE a sheet name. Inside one it
        // is an ordinary character of the name — see `SheetNameSpan`.
        if ch == '"' && !sheet_name.inside() {
            in_string = !in_string;
            result.push(ch);
            i += 1;
            continue;
        }
        if in_string {
            // Don't translate inside string literals
            result.push(ch);
            i += 1;
            continue;
        }

        // THE SHEET-NAME SPAN IS TESTED BEFORE THE BRACE STACK AND BEFORE ANY
        // SEPARATOR REWRITE, because everything between the apostrophes is a
        // NAME and none of it is syntax. Without this, the `{` in
        // `='Draft {1'!A1;B1` opened an array-constant context that OUTLIVED the
        // name, and the `;` after it was read as an array row break.
        let verbatim = sheet_name.observe(ch, chars.get(i + 1).copied());
        if verbatim > 0 {
            for k in 0..verbatim {
                result.push(chars[i + k]);
            }
            i += verbatim;
            continue;
        }

        braces.observe(ch);

        if braces.in_array_constant() {
            // INSIDE AN ARRAY CONSTANT the separators mean different things, and
            // this is the case a blind rewrite gets silently wrong. In a
            // `;`-list-separator locale Excel uses `\` for the COLUMN break and
            // keeps `;` for the ROW break, so `={1\2;3\4}` is a 2x2 block. Map
            // `\` to the invariant column separator `,` and LEAVE `;` alone —
            // rewriting it to `,` here is what would flatten a matrix into one
            // row, with no error and no way for the user to see it happen.
            if ch == ARRAY_COLUMN_SEPARATOR {
                result.push(',');
                i += 1;
                continue;
            }
            if ch == ';' {
                result.push(';');
                i += 1;
                continue;
            }
        } else if ch == locale.list_separator && locale.list_separator != ',' {
            // List separator -> comma
            result.push(',');
            i += 1;
            continue;
        }

        if ch == locale.decimal_separator && locale.decimal_separator != '.' {
            // Decimal separator -> dot. Unambiguous even inside braces: the
            // column break there is `\`, so a `,` can only be a decimal point.
            result.push('.');
        } else {
            result.push(ch);
        }

        i += 1;
    }

    result
}

/// The COLUMN separator inside an array constant in a locale whose list
/// separator is `;`.
///
/// CONFIRMED IN A REAL SWEDISH EXCEL, with screenshots, 2026-08-19: `={1\2;3\4}`
/// spills a 2x2 block and `={1;2;3}` spills a 3x1 COLUMN. Do not re-derive this
/// from Microsoft's documentation — the sv-SE array-constants page carries
/// untranslated prose saying "kommatecken", i.e. the vendor's own docs read the
/// opposite way, and a casual re-check flips it back.
const ARRAY_COLUMN_SEPARATOR: char = '\\';

/// Tracks whether the character being translated sits inside an ARRAY CONSTANT.
///
/// Brace DEPTH alone is not enough, because `{…}` is also Calcula's dict literal
/// (`{"a": 1, "b": 2}`), whose entry separator is an ordinary list separator and
/// must keep translating as one. The two are told apart the same way the parser
/// tells them apart: a dict has a `:` after its first element, so a colon seen
/// at this depth BEFORE any separator marks the group as a dict.
struct BraceStack {
    /// One entry per open brace: `true` once the group is known to be a dict.
    groups: Vec<bool>,
    /// Whether the innermost group has seen a separator yet (after which a `:`
    /// can no longer be the dict marker).
    separated: Vec<bool>,
}

impl BraceStack {
    fn new() -> Self {
        BraceStack { groups: Vec::new(), separated: Vec::new() }
    }

    fn observe(&mut self, ch: char) {
        match ch {
            '{' => {
                self.groups.push(false);
                self.separated.push(false);
            }
            '}' => {
                self.groups.pop();
                self.separated.pop();
            }
            ':' => {
                if let (Some(is_dict), Some(false)) =
                    (self.groups.last_mut(), self.separated.last().copied())
                {
                    *is_dict = true;
                }
            }
            ',' | ';' | ARRAY_COLUMN_SEPARATOR => {
                if let Some(sep) = self.separated.last_mut() {
                    *sep = true;
                }
            }
            _ => {}
        }
    }

    fn in_array_constant(&self) -> bool {
        matches!(self.groups.last(), Some(false))
    }
}

/// Tracks whether the character being translated sits inside an APOSTROPHE-QUOTED
/// SHEET NAME (`='Q1;Q2'!A1`) — the THIRD span kind, alongside string literals and
/// array constants.
///
/// WHY IT EXISTS — EVERY ROW BELOW MEASURED ON THIS FILE BEFORE THE FIX (sv-SE). Excel
/// permits `;` `,` and `"` in a sheet name and only forbids `: \ / ? * [ ]` and a
/// bare `'` (which doubles as `''`). Both translators walked the formula knowing
/// only about `"` spans, so a name was treated as syntax:
///
///   ='Q1;Q2'!A1              delocalize   ='Q1,Q2'!A1        name silently renamed
///   ='Q1,Q2'!A1+1.5          localize     ='Q1;Q2'!A1+1,5    same, other direction
///   ='Q1,Q2'!A1+1,5          delocalize   ='Q1.Q2'!A1+1.5    decimal rule ate the `,`
///   ='Q1.5'!A1               localize     ='Q1,5'!A1         decimal rule ate the `.`
///   ='Draft {1'!A1;B1        delocalize   ='Draft {1'!A1;B1  name opened an array
///                                                            context that outlived it, so
///                                                            the `;` after the name was
///                                                            read as an array ROW break
///                                                            and never became `,`
///
/// The worst is the lone double quote, because the damage is UNBOUNDED rather
/// than local. `"` inside a name latched the `in_string` flag, so every remaining
/// character of the formula was handled in the wrong mode:
///
///   =SUM('12" pipe'!A1;B1;1,5)   delocalize   unchanged — the `;` never became
///                                             `,` and the `1,5` never became
///                                             `1.5`, so the stored formula is
///                                             not invariant at all
///
/// A range or a `SUM` that lost its separators is a wrong NUMBER with no error on
/// the cell, and a renamed sheet is a `#REF!` on the next open.
///
/// SHAPE BORROWED FROM `rewrite_outside_strings` (app/src-tauri/src/commands/
/// structure.rs), which skips string spans and depth-counted bracket spans for the
/// same reason: a span the walker does not know about is not neutral, it is
/// actively misread.
///
/// AN UNTERMINATED APOSTROPHE (a half-typed formula) leaves the rest of the input
/// verbatim. That matches what the existing `"` handling already does with an
/// unterminated string, and copying too much is the safe direction: it declines
/// to translate rather than translating wrongly.
struct SheetNameSpan {
    inside: bool,
}

impl SheetNameSpan {
    fn new() -> Self {
        SheetNameSpan { inside: false }
    }

    fn inside(&self) -> bool {
        self.inside
    }

    /// Feed the current character and the one after it (for the `''` escape).
    ///
    /// Returns how many characters the caller must copy VERBATIM: `0` means the
    /// character is ordinary and should be translated as usual, `1` copies this
    /// character, `2` copies an escaped `''` pair whole. Returning a COUNT rather
    /// than a flag is what keeps `='It''s Data'!A1` one name: consuming both
    /// apostrophes together means the escape can never be mistaken for a close
    /// followed by a re-open.
    fn observe(&mut self, ch: char, next: Option<char>) -> usize {
        if ch != '\'' {
            return if self.inside { 1 } else { 0 };
        }
        if !self.inside {
            self.inside = true;
            return 1;
        }
        if next == Some('\'') {
            // `''` is one literal apostrophe in the name, not the end of it.
            return 2;
        }
        self.inside = false;
        1
    }
}

/// Convert a formula from invariant (US) format to locale format for display.
///
/// Example (sv-SE): `=SUMMA(A1,B1,1.5)` -> `=SUMMA(A1;B1;1,5)`
///
/// When `list_separator` is ';':
///   - ',' -> ';' (argument separator)
///   - '.' in numeric contexts -> ',' (decimal separator)
/// When `list_separator` is ',': no translation needed.
pub fn localize_formula(invariant: &str, locale: &LocaleSettings) -> String {
    if locale.list_separator == ',' && locale.decimal_separator == '.' {
        return invariant.to_string();
    }

    let mut result = String::with_capacity(invariant.len());
    let chars: Vec<char> = invariant.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut in_string = false;
    let mut sheet_name = SheetNameSpan::new();
    let mut braces = BraceStack::new();

    while i < len {
        let ch = chars[i];

        // A `"` only opens a string literal OUTSIDE a sheet name. Inside one it
        // is an ordinary character of the name — see `SheetNameSpan`.
        if ch == '"' && !sheet_name.inside() {
            in_string = !in_string;
            result.push(ch);
            i += 1;
            continue;
        }

        if in_string {
            result.push(ch);
            i += 1;
            continue;
        }

        // Mirror of `delocalize_formula`: the sheet-name span is tested before
        // the brace stack and before the separator and decimal rules. A rule
        // applied in only ONE direction is worse than one applied in neither,
        // because the formula then changes every time it is edited.
        let verbatim = sheet_name.observe(ch, chars.get(i + 1).copied());
        if verbatim > 0 {
            for k in 0..verbatim {
                result.push(chars[i + k]);
            }
            i += verbatim;
            continue;
        }

        braces.observe(ch);

        // INSIDE AN ARRAY CONSTANT, mirror `delocalize_formula`: the invariant
        // `,` is a COLUMN break and becomes `\`, while `;` is the ROW break and
        // stays. Sending the column break to the list separator instead would
        // display a 2x2 constant as a flat row, and re-entry would then make
        // that display true.
        if braces.in_array_constant() && ch == ',' {
            result.push(ARRAY_COLUMN_SEPARATOR);
            i += 1;
            continue;
        }

        if ch == ',' {
            // Comma in invariant -> locale list separator
            result.push(locale.list_separator);
        } else if ch == '.' {
            // Dot in invariant: is it a decimal point in a number context?
            // Check if surrounded by digits
            let prev_is_digit = i > 0 && chars[i - 1].is_ascii_digit();
            let next_is_digit = i + 1 < len && chars[i + 1].is_ascii_digit();
            if prev_is_digit && next_is_digit {
                result.push(locale.decimal_separator);
            } else {
                // Could be part of a range reference like Sheet1.A1 (unlikely in our parser)
                // or just a non-numeric dot; keep as-is
                result.push(ch);
            }
        } else {
            result.push(ch);
        }

        i += 1;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn se() -> LocaleSettings {
        LocaleSettings::from_locale_id("sv-SE")
    }

    fn us() -> LocaleSettings {
        LocaleSettings::invariant()
    }

    #[test]
    fn test_delocalize_no_change_for_us() {
        let formula = "=SUM(A1,B1,1.5)";
        assert_eq!(delocalize_formula(formula, &us()), formula);
    }

    // ---- Array constants and the separator collision ----
    //
    // THE DEFECT THESE PIN. `delocalize_formula` used to be a blind character
    // rewrite mapping `;` -> `,` with no brace awareness. On a `;`-list-separator
    // machine that turns Excel's `={1\2;3\4}` — a 2x2 block — into `={1,2,3,4}`,
    // a flat row of four, with no error. The user sees a 2x2 spill until the
    // first innocent re-entry of the formula, and then sees a 1x4 one.

    #[test]
    fn a_two_dimensional_array_constant_does_not_flatten_on_a_swedish_machine() {
        let locale = se();
        // `\` is the COLUMN break, `;` the ROW break (confirmed in a real
        // Swedish Excel, 2026-08-19). Both survive the trip to invariant form.
        assert_eq!(delocalize_formula("={1\\2;3\\4}", &locale), "={1,2;3,4}");
        assert_eq!(localize_formula("={1,2;3,4}", &locale), "={1\\2;3\\4}");
    }

    #[test]
    fn a_column_constant_stays_a_column_and_a_row_stays_a_row() {
        let locale = se();
        // `={1;2;3}` is a 3x1 COLUMN in sv-SE and must not become a row.
        assert_eq!(delocalize_formula("={1;2;3}", &locale), "={1;2;3}");
        assert_eq!(localize_formula("={1;2;3}", &locale), "={1;2;3}");
        // `={1\2\3}` is a 1x3 ROW.
        assert_eq!(delocalize_formula("={1\\2\\3}", &locale), "={1,2,3}");
        assert_eq!(localize_formula("={1,2,3}", &locale), "={1\\2\\3}");
    }

    #[test]
    fn the_argument_separator_outside_braces_is_untouched_by_the_array_rule() {
        let locale = se();
        assert_eq!(
            delocalize_formula("=SUM({1\\2;3\\4};A1)", &locale),
            "=SUM({1,2;3,4},A1)"
        );
        assert_eq!(
            localize_formula("=SUM({1,2;3,4},A1)", &locale),
            "=SUM({1\\2;3\\4};A1)"
        );
    }

    #[test]
    fn a_decimal_comma_inside_an_array_constant_is_still_a_decimal_point() {
        let locale = se();
        // Unambiguous: the column break inside braces is `\`, so `,` can only
        // be the decimal separator.
        assert_eq!(delocalize_formula("={1,5\\2,5}", &locale), "={1.5,2.5}");
        assert_eq!(localize_formula("={1.5,2.5}", &locale), "={1,5\\2,5}");
    }

    #[test]
    fn a_dict_literal_keeps_the_ordinary_list_separator() {
        let locale = se();
        // `{…}` is also Calcula's dict literal, and its entry separator is an
        // ordinary list separator. The colon after the first element is what
        // distinguishes it — the same signal the parser uses.
        assert_eq!(
            delocalize_formula("={\"a\": 1; \"b\": 2}", &locale),
            "={\"a\": 1, \"b\": 2}"
        );
        assert_eq!(
            localize_formula("={\"a\": 1, \"b\": 2}", &locale),
            "={\"a\": 1; \"b\": 2}"
        );
    }

    #[test]
    fn an_array_constant_round_trips_through_both_directions() {
        let locale = se();
        for localized in [
            "={1\\2;3\\4}",
            "={1;2;3}",
            "={1\\2\\3}",
            "=SUM({1\\2};{3\\4})",
            "=IF(A1>1,5;{1\\2};{3\\4})",
        ] {
            let invariant = delocalize_formula(localized, &locale);
            assert_eq!(
                localize_formula(&invariant, &locale),
                localized,
                "round trip broke for {}",
                localized
            );
        }
    }

    #[test]
    fn braces_inside_a_string_literal_do_not_open_an_array_context() {
        let locale = se();
        assert_eq!(
            delocalize_formula("=IF(A1;\"{a;b}\";B1)", &locale),
            "=IF(A1,\"{a;b}\",B1)"
        );
    }

    #[test]
    fn test_delocalize_swedish() {
        let locale = se();
        assert_eq!(
            delocalize_formula("=SUM(A1;B1;1,5)", &locale),
            "=SUM(A1,B1,1.5)"
        );
    }

    #[test]
    fn test_delocalize_preserves_strings() {
        let locale = se();
        assert_eq!(
            delocalize_formula("=IF(A1>0;\"yes;no\";B1)", &locale),
            "=IF(A1>0,\"yes;no\",B1)"
        );
    }

    #[test]
    fn test_delocalize_nested() {
        let locale = se();
        assert_eq!(
            delocalize_formula("=IF(A1>1,5;SUM(B1;B2);0)", &locale),
            "=IF(A1>1.5,SUM(B1,B2),0)"
        );
    }

    #[test]
    fn test_localize_no_change_for_us() {
        let formula = "=SUM(A1,B1,1.5)";
        assert_eq!(localize_formula(formula, &us()), formula);
    }

    #[test]
    fn test_localize_swedish() {
        let locale = se();
        assert_eq!(
            localize_formula("=SUM(A1,B1,1.5)", &locale),
            "=SUM(A1;B1;1,5)"
        );
    }

    #[test]
    fn test_localize_preserves_strings() {
        let locale = se();
        assert_eq!(
            localize_formula("=IF(A1>0,\"yes,no\",B1)", &locale),
            "=IF(A1>0;\"yes,no\";B1)"
        );
    }

    #[test]
    fn test_roundtrip() {
        let locale = se();
        let original = "=IF(A1>1.5,SUM(B1,B2),0)";
        let localized = localize_formula(original, &locale);
        let delocalized = delocalize_formula(&localized, &locale);
        assert_eq!(delocalized, original);
    }

    // ---- Apostrophe-quoted sheet names ----
    //
    // THE DEFECTS THESE PIN, all measured on this file before the fix. Excel
    // allows `;` `,` and `"` in a sheet name and forbids only `: \ / ? * [ ]`
    // and a bare `'` (which doubles as `''`). Both translators knew about `"`
    // spans only, so a NAME was rewritten as if it were SYNTAX. The measured
    // before/after table is on `SheetNameSpan`.

    #[test]
    fn a_list_separator_inside_a_sheet_name_is_not_a_separator() {
        let locale = se();
        // Was: `='Q1,Q2'!A1` — the formula now names a sheet that does not
        // exist, so the workbook answers #REF! with nothing to see in the UI.
        assert_eq!(delocalize_formula("='Q1;Q2'!A1", &locale), "='Q1;Q2'!A1");
        assert_eq!(localize_formula("='Q1,Q2'!A1", &locale), "='Q1,Q2'!A1");
        // CONTROL, and it is the point of this test: the separator immediately
        // AFTER the closing apostrophe is ordinary syntax and must still
        // translate. Without it a "fix" that simply stopped translating from
        // the first apostrophe onward would satisfy the assertions above.
        assert_eq!(
            delocalize_formula("=SUM('Q1;Q2'!A1;B1)", &locale),
            "=SUM('Q1;Q2'!A1,B1)"
        );
        assert_eq!(
            localize_formula("=SUM('Q1,Q2'!A1,B1)", &locale),
            "=SUM('Q1,Q2'!A1;B1)"
        );
    }

    #[test]
    fn the_decimal_rule_does_not_reach_inside_a_sheet_name() {
        let locale = se();
        // Was: `='Q1.Q2'!A1+1.5` and `='Q1,5'!A1`. A sheet name is not a
        // number, and the `.`-between-digits heuristic cannot tell them apart.
        assert_eq!(
            delocalize_formula("='Q1,Q2'!A1+1,5", &locale),
            "='Q1,Q2'!A1+1.5"
        );
        assert_eq!(localize_formula("='Q1.5'!A1", &locale), "='Q1.5'!A1");
        // CONTROL: a real decimal point outside the name still moves, so a fix
        // that disabled the decimal rule wholesale cannot pass.
        assert_eq!(localize_formula("='Q1.5'!A1+1.5", &locale), "='Q1.5'!A1+1,5");
    }

    #[test]
    fn a_double_quote_inside_a_sheet_name_does_not_desynchronise_the_rest() {
        let locale = se();
        // THE WORST OF THEM, because the damage is UNBOUNDED rather than local:
        // the lone `"` latched the `in_string` flag, so every remaining
        // character of the formula was handled in the wrong mode. The formula
        // below came back completely untouched — the `;` never became `,` and
        // `1,5` never became `1.5` — so what was stored as "invariant" was not
        // invariant at all, and the engine parsed a different formula than the
        // one the user typed.
        assert_eq!(
            delocalize_formula("=SUM('12\" pipe'!A1;B1;1,5)", &locale),
            "=SUM('12\" pipe'!A1,B1,1.5)"
        );
        assert_eq!(
            localize_formula("=SUM('12\" pipe'!A1,B1,1.5)", &locale),
            "=SUM('12\" pipe'!A1;B1;1,5)"
        );
    }

    #[test]
    fn a_doubled_apostrophe_is_one_character_of_the_name_not_a_close() {
        let locale = se();
        // `'It''s Data'` is ONE name containing an apostrophe. Were the `''`
        // read as close-then-reopen, the span would end an apostrophe early and
        // the `;` after `!A1` would sit inside a phantom second name.
        assert_eq!(
            delocalize_formula("=SUM('It''s Data'!A1;B1)", &locale),
            "=SUM('It''s Data'!A1,B1)"
        );
        assert_eq!(
            localize_formula("=SUM('It''s Data'!A1,B1)", &locale),
            "=SUM('It''s Data'!A1;B1)"
        );
        // A separator inside such a name is still opaque.
        assert_eq!(
            delocalize_formula("='It''s;Data'!A1", &locale),
            "='It''s;Data'!A1"
        );
    }

    #[test]
    fn a_sheet_name_composes_with_the_brace_stack_rather_than_fighting_it() {
        let locale = se();
        // A BRACE INSIDE A NAME MUST NOT REACH THE BRACE STACK. Excel forbids
        // `: \ / ? * [ ]` in a sheet name but permits `{` and `}`, and an
        // UNBALANCED one is the case with teeth: a `{` swallowed by the name
        // leaves the stack believing the REST of the formula sits inside an
        // array constant, where `;` is the ROW break and is deliberately left
        // alone — so the argument separator after the name silently stopped
        // converting. (A balanced `{…}` inside a name cancels out and proves
        // nothing; the first draft of this test used one and no sabotage of the
        // ordering could red it.)
        assert_eq!(
            delocalize_formula("='Draft {1'!A1;B1", &locale),
            "='Draft {1'!A1,B1"
        );
        assert_eq!(
            localize_formula("='Draft {1'!A1,B1", &locale),
            "='Draft {1'!A1;B1"
        );
        // CONTROL: a real array constant in the SAME formula as a quoted name
        // still follows the sv-SE rule — `\` is the COLUMN break, `;` the ROW
        // break — so the new span rule composes with `BraceStack` instead of
        // suppressing it.
        assert_eq!(
            delocalize_formula("=SUM('Q1;Q2'!A1;{1\\2;3\\4})", &locale),
            "=SUM('Q1;Q2'!A1,{1,2;3,4})"
        );
        assert_eq!(
            localize_formula("=SUM('Q1,Q2'!A1,{1,2;3,4})", &locale),
            "=SUM('Q1,Q2'!A1;{1\\2;3\\4})"
        );
    }

    #[test]
    fn an_apostrophe_inside_a_string_literal_does_not_open_a_sheet_name() {
        let locale = se();
        // The string span wins. An odd apostrophe in prose is ordinary English,
        // and opening a name span on it would make the separator after the
        // string stop translating — the same unbounded desync, mirrored.
        assert_eq!(
            delocalize_formula("=IF(A1;\"don't\";B1)", &locale),
            "=IF(A1,\"don't\",B1)"
        );
        assert_eq!(
            localize_formula("=IF(A1,\"don't\",B1)", &locale),
            "=IF(A1;\"don't\";B1)"
        );
    }

    #[test]
    fn a_sheet_name_round_trips_through_both_directions() {
        let locale = se();
        // A formula that survives ONE direction and not the other is precisely
        // the defect this file exists to prevent: it mutates on every edit,
        // drifting a little further each time and never raising an error.
        for localized in [
            "='Q1;Q2'!A1",
            "='Q1,Q2'!A1+1,5",
            "='Q1.5'!A1+1,5",
            "=SUM('12\" pipe'!A1;B1;1,5)",
            "=SUM('It''s Data'!A1;B1)",
            "='Draft {1'!A1;B1",
            "=SUM('Q1;Q2'!A1;{1\\2;3\\4})",
            "=IF(A1;\"don't\";'It''s;Data'!B1)",
        ] {
            let invariant = delocalize_formula(localized, &locale);
            assert_eq!(
                localize_formula(&invariant, &locale),
                localized,
                "round trip broke for {}",
                localized
            );
        }
    }

    #[test]
    fn test_delocalize_simple_number() {
        let locale = se();
        // Plain cell reference with no function
        assert_eq!(delocalize_formula("=A1+1,5", &locale), "=A1+1.5");
    }
}
