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

    for ch in input.chars() {
        if ch == '"' {
            in_string = !in_string;
            result.push(ch);
        } else if in_string {
            // Don't translate inside string literals
            result.push(ch);
        } else if ch == locale.list_separator && locale.list_separator != ',' {
            // List separator -> comma
            result.push(',');
        } else if ch == locale.decimal_separator && locale.decimal_separator != '.' {
            // Decimal separator -> dot
            result.push('.');
        } else {
            result.push(ch);
        }
    }

    result
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
