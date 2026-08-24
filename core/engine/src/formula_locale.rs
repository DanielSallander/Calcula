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
    let mut in_string = false;
    let mut braces = BraceStack::new();

    for ch in input.chars() {
        if ch == '"' {
            in_string = !in_string;
            result.push(ch);
            continue;
        }
        if in_string {
            // Don't translate inside string literals
            result.push(ch);
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
                continue;
            }
            if ch == ';' {
                result.push(';');
                continue;
            }
        } else if ch == locale.list_separator && locale.list_separator != ',' {
            // List separator -> comma
            result.push(',');
            continue;
        }

        if ch == locale.decimal_separator && locale.decimal_separator != '.' {
            // Decimal separator -> dot. Unambiguous even inside braces: the
            // column break there is `\`, so a `,` can only be a decimal point.
            result.push('.');
        } else {
            result.push(ch);
        }
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
    let mut braces = BraceStack::new();

    while i < len {
        let ch = chars[i];

        if ch == '"' {
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

    #[test]
    fn test_delocalize_simple_number() {
        let locale = se();
        // Plain cell reference with no function
        assert_eq!(delocalize_formula("=A1+1,5", &locale), "=A1+1.5");
    }
}
