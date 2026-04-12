//! FILENAME: core/engine/src/locale.rs
//! PURPOSE: Locale/regional settings for number formatting, date parsing,
//!          and formula display.
//! CONTEXT: Defines separator conventions per locale. Internal storage always
//!          uses invariant (US-English) format; locale settings are applied
//!          only at input/output boundaries.

use serde::{Deserialize, Serialize};

/// Position of the currency symbol relative to the number.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum LocaleCurrencyPosition {
    Before,
    After,
}

/// Regional settings that control how numbers, dates, and formulas
/// are displayed and parsed for the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleSettings {
    /// BCP 47 locale identifier, e.g. "en-US", "sv-SE", "de-DE"
    pub locale_id: String,
    /// Display name for the settings UI, e.g. "English (United States)"
    pub display_name: String,
    /// Decimal separator: '.' (US/UK) or ',' (most of Europe)
    pub decimal_separator: char,
    /// Thousands/grouping separator: ',' (US), '.' (DE), ' ' (FR/SE)
    pub thousands_separator: char,
    /// List separator used in formulas: ',' (US) or ';' (Europe)
    pub list_separator: char,
    /// Default date format pattern, e.g. "YYYY-MM-DD", "MM/DD/YYYY", "DD.MM.YYYY"
    pub date_format: String,
    /// Default currency symbol
    pub currency_symbol: String,
    /// Whether currency symbol appears before or after the number
    pub currency_position: LocaleCurrencyPosition,
}

impl LocaleSettings {
    /// The invariant (US-English) locale used for internal storage.
    /// Formulas, cell values, and file formats always use this.
    pub fn invariant() -> Self {
        Self {
            locale_id: "en-US".to_string(),
            display_name: "English (United States)".to_string(),
            decimal_separator: '.',
            thousands_separator: ',',
            list_separator: ',',
            date_format: "MM/DD/YYYY".to_string(),
            currency_symbol: "$".to_string(),
            currency_position: LocaleCurrencyPosition::Before,
        }
    }

    /// Create locale settings from a BCP 47 locale ID.
    /// Falls back to `en-US` for unrecognized locales.
    pub fn from_locale_id(id: &str) -> Self {
        // Normalize: "en_US" -> "en-US", lowercase for matching
        let normalized = id.replace('_', "-");
        let lower = normalized.to_lowercase();

        // Match on full locale first, then language-only fallback
        match lower.as_str() {
            "en-us" => Self::invariant(),

            "en-gb" | "en-au" | "en-nz" | "en-ie" => Self {
                locale_id: "en-GB".to_string(),
                display_name: "English (United Kingdom)".to_string(),
                decimal_separator: '.',
                thousands_separator: ',',
                list_separator: ',',
                date_format: "DD/MM/YYYY".to_string(),
                currency_symbol: "\u{00A3}".to_string(), // GBP
                currency_position: LocaleCurrencyPosition::Before,
            },

            "sv-se" | "sv" => Self {
                locale_id: "sv-SE".to_string(),
                display_name: "Svenska (Sverige)".to_string(),
                decimal_separator: ',',
                thousands_separator: '\u{00A0}', // non-breaking space
                list_separator: ';',
                date_format: "YYYY-MM-DD".to_string(),
                currency_symbol: " kr".to_string(),
                currency_position: LocaleCurrencyPosition::After,
            },

            "de-de" | "de-at" | "de" => Self {
                locale_id: "de-DE".to_string(),
                display_name: "Deutsch (Deutschland)".to_string(),
                decimal_separator: ',',
                thousands_separator: '.',
                list_separator: ';',
                date_format: "DD.MM.YYYY".to_string(),
                currency_symbol: "\u{20AC} ".to_string(), // EUR
                currency_position: LocaleCurrencyPosition::Before,
            },

            "de-ch" => Self {
                locale_id: "de-CH".to_string(),
                display_name: "Deutsch (Schweiz)".to_string(),
                decimal_separator: '.',
                thousands_separator: '\'',
                list_separator: ';',
                date_format: "DD.MM.YYYY".to_string(),
                currency_symbol: "CHF ".to_string(),
                currency_position: LocaleCurrencyPosition::Before,
            },

            "fr-fr" | "fr" => Self {
                locale_id: "fr-FR".to_string(),
                display_name: "Fran\u{00E7}ais (France)".to_string(),
                decimal_separator: ',',
                thousands_separator: '\u{00A0}', // non-breaking space
                list_separator: ';',
                date_format: "DD/MM/YYYY".to_string(),
                currency_symbol: " \u{20AC}".to_string(), // EUR after
                currency_position: LocaleCurrencyPosition::After,
            },

            "nb-no" | "nn-no" | "nb" | "nn" | "no" => Self {
                locale_id: "nb-NO".to_string(),
                display_name: "Norsk (Norge)".to_string(),
                decimal_separator: ',',
                thousands_separator: '\u{00A0}',
                list_separator: ';',
                date_format: "DD.MM.YYYY".to_string(),
                currency_symbol: " kr".to_string(),
                currency_position: LocaleCurrencyPosition::After,
            },

            "da-dk" | "da" => Self {
                locale_id: "da-DK".to_string(),
                display_name: "Dansk (Danmark)".to_string(),
                decimal_separator: ',',
                thousands_separator: '.',
                list_separator: ';',
                date_format: "DD-MM-YYYY".to_string(),
                currency_symbol: " kr.".to_string(),
                currency_position: LocaleCurrencyPosition::After,
            },

            "fi-fi" | "fi" => Self {
                locale_id: "fi-FI".to_string(),
                display_name: "Suomi (Suomi)".to_string(),
                decimal_separator: ',',
                thousands_separator: '\u{00A0}',
                list_separator: ';',
                date_format: "DD.MM.YYYY".to_string(),
                currency_symbol: " \u{20AC}".to_string(),
                currency_position: LocaleCurrencyPosition::After,
            },

            "nl-nl" | "nl" | "nl-be" => Self {
                locale_id: "nl-NL".to_string(),
                display_name: "Nederlands (Nederland)".to_string(),
                decimal_separator: ',',
                thousands_separator: '.',
                list_separator: ';',
                date_format: "DD-MM-YYYY".to_string(),
                currency_symbol: "\u{20AC} ".to_string(),
                currency_position: LocaleCurrencyPosition::Before,
            },

            "it-it" | "it" => Self {
                locale_id: "it-IT".to_string(),
                display_name: "Italiano (Italia)".to_string(),
                decimal_separator: ',',
                thousands_separator: '.',
                list_separator: ';',
                date_format: "DD/MM/YYYY".to_string(),
                currency_symbol: "\u{20AC} ".to_string(),
                currency_position: LocaleCurrencyPosition::Before,
            },

            "es-es" | "es" => Self {
                locale_id: "es-ES".to_string(),
                display_name: "Espa\u{00F1}ol (Espa\u{00F1}a)".to_string(),
                decimal_separator: ',',
                thousands_separator: '.',
                list_separator: ';',
                date_format: "DD/MM/YYYY".to_string(),
                currency_symbol: " \u{20AC}".to_string(),
                currency_position: LocaleCurrencyPosition::After,
            },

            "pt-br" | "pt" => Self {
                locale_id: "pt-BR".to_string(),
                display_name: "Portugu\u{00EA}s (Brasil)".to_string(),
                decimal_separator: ',',
                thousands_separator: '.',
                list_separator: ';',
                date_format: "DD/MM/YYYY".to_string(),
                currency_symbol: "R$ ".to_string(),
                currency_position: LocaleCurrencyPosition::Before,
            },

            "ja-jp" | "ja" => Self {
                locale_id: "ja-JP".to_string(),
                display_name: "\u{65E5}\u{672C}\u{8A9E} (\u{65E5}\u{672C})".to_string(),
                decimal_separator: '.',
                thousands_separator: ',',
                list_separator: ',',
                date_format: "YYYY/MM/DD".to_string(),
                currency_symbol: "\u{00A5}".to_string(),
                currency_position: LocaleCurrencyPosition::Before,
            },

            "zh-cn" | "zh" => Self {
                locale_id: "zh-CN".to_string(),
                display_name: "\u{4E2D}\u{6587} (\u{4E2D}\u{56FD})".to_string(),
                decimal_separator: '.',
                thousands_separator: ',',
                list_separator: ',',
                date_format: "YYYY/MM/DD".to_string(),
                currency_symbol: "\u{00A5}".to_string(),
                currency_position: LocaleCurrencyPosition::Before,
            },

            "ko-kr" | "ko" => Self {
                locale_id: "ko-KR".to_string(),
                display_name: "\u{D55C}\u{AD6D}\u{C5B4} (\u{B300}\u{D55C}\u{BBFC}\u{AD6D})".to_string(),
                decimal_separator: '.',
                thousands_separator: ',',
                list_separator: ',',
                date_format: "YYYY-MM-DD".to_string(),
                currency_symbol: "\u{20A9}".to_string(),
                currency_position: LocaleCurrencyPosition::Before,
            },

            "pl-pl" | "pl" => Self {
                locale_id: "pl-PL".to_string(),
                display_name: "Polski (Polska)".to_string(),
                decimal_separator: ',',
                thousands_separator: '\u{00A0}',
                list_separator: ';',
                date_format: "DD.MM.YYYY".to_string(),
                currency_symbol: " z\u{0142}".to_string(),
                currency_position: LocaleCurrencyPosition::After,
            },

            "ru-ru" | "ru" => Self {
                locale_id: "ru-RU".to_string(),
                display_name: "\u{0420}\u{0443}\u{0441}\u{0441}\u{043A}\u{0438}\u{0439} (\u{0420}\u{043E}\u{0441}\u{0441}\u{0438}\u{044F})".to_string(),
                decimal_separator: ',',
                thousands_separator: '\u{00A0}',
                list_separator: ';',
                date_format: "DD.MM.YYYY".to_string(),
                currency_symbol: " \u{20BD}".to_string(),
                currency_position: LocaleCurrencyPosition::After,
            },

            // Fallback: English (US)
            _ => {
                // Try matching just the language part
                if let Some(lang) = lower.split('-').next() {
                    if lang != lower.as_str() {
                        return Self::from_locale_id(lang);
                    }
                }
                Self::invariant()
            }
        }
    }

    /// Returns all supported locale IDs with their display names.
    pub fn supported_locales() -> Vec<(String, String)> {
        vec![
            ("en-US".to_string(), "English (United States)".to_string()),
            ("en-GB".to_string(), "English (United Kingdom)".to_string()),
            ("sv-SE".to_string(), "Svenska (Sverige)".to_string()),
            ("de-DE".to_string(), "Deutsch (Deutschland)".to_string()),
            ("de-CH".to_string(), "Deutsch (Schweiz)".to_string()),
            ("fr-FR".to_string(), "Fran\u{00E7}ais (France)".to_string()),
            ("nb-NO".to_string(), "Norsk (Norge)".to_string()),
            ("da-DK".to_string(), "Dansk (Danmark)".to_string()),
            ("fi-FI".to_string(), "Suomi (Suomi)".to_string()),
            ("nl-NL".to_string(), "Nederlands (Nederland)".to_string()),
            ("it-IT".to_string(), "Italiano (Italia)".to_string()),
            ("es-ES".to_string(), "Espa\u{00F1}ol (Espa\u{00F1}a)".to_string()),
            ("pt-BR".to_string(), "Portugu\u{00EA}s (Brasil)".to_string()),
            ("ja-JP".to_string(), "\u{65E5}\u{672C}\u{8A9E} (\u{65E5}\u{672C})".to_string()),
            ("zh-CN".to_string(), "\u{4E2D}\u{6587} (\u{4E2D}\u{56FD})".to_string()),
            ("ko-KR".to_string(), "\u{D55C}\u{AD6D}\u{C5B4} (\u{B300}\u{D55C}\u{BBFC}\u{AD6D})".to_string()),
            ("pl-PL".to_string(), "Polski (Polska)".to_string()),
            ("ru-RU".to_string(), "\u{0420}\u{0443}\u{0441}\u{0441}\u{043A}\u{0438}\u{0439} (\u{0420}\u{043E}\u{0441}\u{0441}\u{0438}\u{044F})".to_string()),
        ]
    }

    /// Whether this locale uses comma as decimal separator.
    pub fn uses_comma_decimal(&self) -> bool {
        self.decimal_separator == ','
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invariant_locale() {
        let locale = LocaleSettings::invariant();
        assert_eq!(locale.decimal_separator, '.');
        assert_eq!(locale.thousands_separator, ',');
        assert_eq!(locale.list_separator, ',');
    }

    #[test]
    fn test_swedish_locale() {
        let locale = LocaleSettings::from_locale_id("sv-SE");
        assert_eq!(locale.decimal_separator, ',');
        assert_eq!(locale.list_separator, ';');
        assert_eq!(locale.date_format, "YYYY-MM-DD");
    }

    #[test]
    fn test_german_locale() {
        let locale = LocaleSettings::from_locale_id("de-DE");
        assert_eq!(locale.decimal_separator, ',');
        assert_eq!(locale.thousands_separator, '.');
        assert_eq!(locale.list_separator, ';');
        assert_eq!(locale.date_format, "DD.MM.YYYY");
    }

    #[test]
    fn test_locale_normalization() {
        // Underscore instead of hyphen
        let locale = LocaleSettings::from_locale_id("sv_SE");
        assert_eq!(locale.locale_id, "sv-SE");

        // Language-only fallback
        let locale = LocaleSettings::from_locale_id("sv");
        assert_eq!(locale.locale_id, "sv-SE");
    }

    #[test]
    fn test_unknown_locale_fallback() {
        let locale = LocaleSettings::from_locale_id("xx-XX");
        assert_eq!(locale.locale_id, "en-US");
    }

    #[test]
    fn test_supported_locales_not_empty() {
        let locales = LocaleSettings::supported_locales();
        assert!(locales.len() >= 10);
    }
}
