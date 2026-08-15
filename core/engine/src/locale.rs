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
    /// Long date pattern (Windows `LOCALE_SLONGDATE`), e.g.
    /// `"dddd, mmmm d, yyyy"` (en-US) or `"\"den \"d mmmm yyyy"` (sv-SE).
    /// Excel's ribbon Long Date entry writes `[$-x-sysdate]`, which means
    /// "use the OS long date" -- this field is that pattern.
    pub long_date_format: String,
    /// Long time pattern (Windows `LOCALE_STIMEFORMAT`) WITH seconds, e.g.
    /// `"h:mm:ss AM/PM"` (en-US) or `"hh:mm:ss"` (sv-SE, which has no AM/PM
    /// designator). Excel's ribbon Time entry writes `[$-x-systime]`.
    pub time_format: String,
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
            long_date_format: "dddd, mmmm d, yyyy".to_string(),
            time_format: "h:mm:ss AM/PM".to_string(),
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
                long_date_format: "dd mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "\"den \"d mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd, d. mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd, d. mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd d mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd d. mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "d. mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "d. mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd d mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd d mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd, d \"de\" mmmm \"de\" yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "dddd, d \"de\" mmmm \"de\" yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "yyyy\"\u{5E74}\"m\"\u{6708}\"d\"\u{65E5}\"".to_string(),
                time_format: "h:mm:ss".to_string(),
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
                long_date_format: "yyyy\"\u{5E74}\"m\"\u{6708}\"d\"\u{65E5}\"".to_string(),
                time_format: "h:mm:ss".to_string(),
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
                long_date_format: "yyyy\"\u{B144}\" m\"\u{C6D4}\" d\"\u{C77C}\" dddd".to_string(),
                time_format: "h:mm:ss".to_string(),
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
                long_date_format: "d mmmm yyyy".to_string(),
                time_format: "hh:mm:ss".to_string(),
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
                long_date_format: "d mmmm yyyy\" \u{0433}.\"".to_string(),
                time_format: "hh:mm:ss".to_string(),
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

    /// Localized month/weekday names for this locale, resolved from the
    /// LANGUAGE part of `locale_id` (so en-GB and en-US share one table).
    /// Unknown languages fall back to English, matching `from_locale_id`.
    pub fn calendar(&self) -> &'static CalendarNames {
        let lang = self
            .locale_id
            .split('-')
            .next()
            .unwrap_or("en")
            .to_ascii_lowercase();
        match lang.as_str() {
            "sv" => &CALENDAR_SV,
            "de" => &CALENDAR_DE,
            "fr" => &CALENDAR_FR,
            "nb" | "nn" | "no" => &CALENDAR_NB,
            "da" => &CALENDAR_DA,
            "fi" => &CALENDAR_FI,
            "nl" => &CALENDAR_NL,
            "it" => &CALENDAR_IT,
            "es" => &CALENDAR_ES,
            "pt" => &CALENDAR_PT,
            "ja" => &CALENDAR_JA,
            "zh" => &CALENDAR_ZH,
            "ko" => &CALENDAR_KO,
            "pl" => &CALENDAR_PL,
            "ru" => &CALENDAR_RU,
            _ => &CALENDAR_EN,
        }
    }

}

/// Localized month and weekday names for the `mmm`/`mmmm`/`mmmmm`/`ddd`/`dddd`
/// date tokens. Excel renders those tokens in the SYSTEM locale's language --
/// a Swedish machine shows `den 15 januari 2024`, not `den 15 January 2024` --
/// so the custom-format engine resolves every name through here instead of the
/// English-only tables it used to carry. Indices: months 0..11 = January..
/// December; days 0..6 = Sunday..Saturday (matching `day_of_week`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CalendarNames {
    pub months_full: [&'static str; 12],
    pub months_short: [&'static str; 12],
    pub days_full: [&'static str; 7],
    pub days_short: [&'static str; 7],
}

const CALENDAR_EN: CalendarNames = CalendarNames {
    months_full: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    months_short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    days_full: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    days_short: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

const CALENDAR_SV: CalendarNames = CalendarNames {
    months_full: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
    months_short: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
    days_full: ["s\u{00F6}ndag", "m\u{00E5}ndag", "tisdag", "onsdag", "torsdag", "fredag", "l\u{00F6}rdag"],
    days_short: ["s\u{00F6}n", "m\u{00E5}n", "tis", "ons", "tor", "fre", "l\u{00F6}r"],
};

const CALENDAR_DE: CalendarNames = CalendarNames {
    months_full: ["Januar", "Februar", "M\u{00E4}rz", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    months_short: ["Jan", "Feb", "M\u{00E4}r", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
    days_full: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
    days_short: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
};

const CALENDAR_FR: CalendarNames = CalendarNames {
    months_full: ["janvier", "f\u{00E9}vrier", "mars", "avril", "mai", "juin", "juillet", "ao\u{00FB}t", "septembre", "octobre", "novembre", "d\u{00E9}cembre"],
    months_short: ["janv.", "f\u{00E9}vr.", "mars", "avr.", "mai", "juin", "juil.", "ao\u{00FB}t", "sept.", "oct.", "nov.", "d\u{00E9}c."],
    days_full: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    days_short: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
};

const CALENDAR_NB: CalendarNames = CalendarNames {
    months_full: ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"],
    months_short: ["jan.", "feb.", "mar.", "apr.", "mai", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "des."],
    days_full: ["s\u{00F8}ndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "l\u{00F8}rdag"],
    days_short: ["s\u{00F8}n.", "man.", "tir.", "ons.", "tor.", "fre.", "l\u{00F8}r."],
};

const CALENDAR_DA: CalendarNames = CalendarNames {
    months_full: ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"],
    months_short: ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."],
    days_full: ["s\u{00F8}ndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "l\u{00F8}rdag"],
    days_short: ["s\u{00F8}n.", "man.", "tir.", "ons.", "tor.", "fre.", "l\u{00F8}r."],
};

const CALENDAR_FI: CalendarNames = CalendarNames {
    months_full: ["tammikuu", "helmikuu", "maaliskuu", "huhtikuu", "toukokuu", "kes\u{00E4}kuu", "hein\u{00E4}kuu", "elokuu", "syyskuu", "lokakuu", "marraskuu", "joulukuu"],
    months_short: ["tammi", "helmi", "maalis", "huhti", "touko", "kes\u{00E4}", "hein\u{00E4}", "elo", "syys", "loka", "marras", "joulu"],
    days_full: ["sunnuntai", "maanantai", "tiistai", "keskiviikko", "torstai", "perjantai", "lauantai"],
    days_short: ["su", "ma", "ti", "ke", "to", "pe", "la"],
};

const CALENDAR_NL: CalendarNames = CalendarNames {
    months_full: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
    months_short: ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
    days_full: ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"],
    days_short: ["zo", "ma", "di", "wo", "do", "vr", "za"],
};

const CALENDAR_IT: CalendarNames = CalendarNames {
    months_full: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
    months_short: ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"],
    days_full: ["domenica", "luned\u{00EC}", "marted\u{00EC}", "mercoled\u{00EC}", "gioved\u{00EC}", "venerd\u{00EC}", "sabato"],
    days_short: ["dom", "lun", "mar", "mer", "gio", "ven", "sab"],
};

const CALENDAR_ES: CalendarNames = CalendarNames {
    months_full: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    months_short: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
    days_full: ["domingo", "lunes", "martes", "mi\u{00E9}rcoles", "jueves", "viernes", "s\u{00E1}bado"],
    days_short: ["dom", "lun", "mar", "mi\u{00E9}", "jue", "vie", "s\u{00E1}b"],
};

const CALENDAR_PT: CalendarNames = CalendarNames {
    months_full: ["janeiro", "fevereiro", "mar\u{00E7}o", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
    months_short: ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
    days_full: ["domingo", "segunda-feira", "ter\u{00E7}a-feira", "quarta-feira", "quinta-feira", "sexta-feira", "s\u{00E1}bado"],
    days_short: ["dom", "seg", "ter", "qua", "qui", "sex", "s\u{00E1}b"],
};

const CALENDAR_JA: CalendarNames = CalendarNames {
    months_full: ["1\u{6708}", "2\u{6708}", "3\u{6708}", "4\u{6708}", "5\u{6708}", "6\u{6708}", "7\u{6708}", "8\u{6708}", "9\u{6708}", "10\u{6708}", "11\u{6708}", "12\u{6708}"],
    months_short: ["1\u{6708}", "2\u{6708}", "3\u{6708}", "4\u{6708}", "5\u{6708}", "6\u{6708}", "7\u{6708}", "8\u{6708}", "9\u{6708}", "10\u{6708}", "11\u{6708}", "12\u{6708}"],
    days_full: ["\u{65E5}\u{66DC}\u{65E5}", "\u{6708}\u{66DC}\u{65E5}", "\u{706B}\u{66DC}\u{65E5}", "\u{6C34}\u{66DC}\u{65E5}", "\u{6728}\u{66DC}\u{65E5}", "\u{91D1}\u{66DC}\u{65E5}", "\u{571F}\u{66DC}\u{65E5}"],
    days_short: ["\u{65E5}", "\u{6708}", "\u{706B}", "\u{6C34}", "\u{6728}", "\u{91D1}", "\u{571F}"],
};

const CALENDAR_ZH: CalendarNames = CalendarNames {
    months_full: ["\u{4E00}\u{6708}", "\u{4E8C}\u{6708}", "\u{4E09}\u{6708}", "\u{56DB}\u{6708}", "\u{4E94}\u{6708}", "\u{516D}\u{6708}", "\u{4E03}\u{6708}", "\u{516B}\u{6708}", "\u{4E5D}\u{6708}", "\u{5341}\u{6708}", "\u{5341}\u{4E00}\u{6708}", "\u{5341}\u{4E8C}\u{6708}"],
    months_short: ["1\u{6708}", "2\u{6708}", "3\u{6708}", "4\u{6708}", "5\u{6708}", "6\u{6708}", "7\u{6708}", "8\u{6708}", "9\u{6708}", "10\u{6708}", "11\u{6708}", "12\u{6708}"],
    days_full: ["\u{661F}\u{671F}\u{65E5}", "\u{661F}\u{671F}\u{4E00}", "\u{661F}\u{671F}\u{4E8C}", "\u{661F}\u{671F}\u{4E09}", "\u{661F}\u{671F}\u{56DB}", "\u{661F}\u{671F}\u{4E94}", "\u{661F}\u{671F}\u{516D}"],
    days_short: ["\u{5468}\u{65E5}", "\u{5468}\u{4E00}", "\u{5468}\u{4E8C}", "\u{5468}\u{4E09}", "\u{5468}\u{56DB}", "\u{5468}\u{4E94}", "\u{5468}\u{516D}"],
};

const CALENDAR_KO: CalendarNames = CalendarNames {
    months_full: ["1\u{C6D4}", "2\u{C6D4}", "3\u{C6D4}", "4\u{C6D4}", "5\u{C6D4}", "6\u{C6D4}", "7\u{C6D4}", "8\u{C6D4}", "9\u{C6D4}", "10\u{C6D4}", "11\u{C6D4}", "12\u{C6D4}"],
    months_short: ["1\u{C6D4}", "2\u{C6D4}", "3\u{C6D4}", "4\u{C6D4}", "5\u{C6D4}", "6\u{C6D4}", "7\u{C6D4}", "8\u{C6D4}", "9\u{C6D4}", "10\u{C6D4}", "11\u{C6D4}", "12\u{C6D4}"],
    days_full: ["\u{C77C}\u{C694}\u{C77C}", "\u{C6D4}\u{C694}\u{C77C}", "\u{D654}\u{C694}\u{C77C}", "\u{C218}\u{C694}\u{C77C}", "\u{BAA9}\u{C694}\u{C77C}", "\u{AE08}\u{C694}\u{C77C}", "\u{D1A0}\u{C694}\u{C77C}"],
    days_short: ["\u{C77C}", "\u{C6D4}", "\u{D654}", "\u{C218}", "\u{BAA9}", "\u{AE08}", "\u{D1A0}"],
};

const CALENDAR_PL: CalendarNames = CalendarNames {
    months_full: ["stycze\u{0144}", "luty", "marzec", "kwiecie\u{0144}", "maj", "czerwiec", "lipiec", "sierpie\u{0144}", "wrzesie\u{0144}", "pa\u{017A}dziernik", "listopad", "grudzie\u{0144}"],
    months_short: ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "pa\u{017A}", "lis", "gru"],
    days_full: ["niedziela", "poniedzia\u{0142}ek", "wtorek", "\u{015B}roda", "czwartek", "pi\u{0105}tek", "sobota"],
    days_short: ["niedz.", "pon.", "wt.", "\u{015B}r.", "czw.", "pt.", "sob."],
};

const CALENDAR_RU: CalendarNames = CalendarNames {
    months_full: ["\u{044F}\u{043D}\u{0432}\u{0430}\u{0440}\u{044C}", "\u{0444}\u{0435}\u{0432}\u{0440}\u{0430}\u{043B}\u{044C}", "\u{043C}\u{0430}\u{0440}\u{0442}", "\u{0430}\u{043F}\u{0440}\u{0435}\u{043B}\u{044C}", "\u{043C}\u{0430}\u{0439}", "\u{0438}\u{044E}\u{043D}\u{044C}", "\u{0438}\u{044E}\u{043B}\u{044C}", "\u{0430}\u{0432}\u{0433}\u{0443}\u{0441}\u{0442}", "\u{0441}\u{0435}\u{043D}\u{0442}\u{044F}\u{0431}\u{0440}\u{044C}", "\u{043E}\u{043A}\u{0442}\u{044F}\u{0431}\u{0440}\u{044C}", "\u{043D}\u{043E}\u{044F}\u{0431}\u{0440}\u{044C}", "\u{0434}\u{0435}\u{043A}\u{0430}\u{0431}\u{0440}\u{044C}"],
    months_short: ["\u{044F}\u{043D}\u{0432}", "\u{0444}\u{0435}\u{0432}", "\u{043C}\u{0430}\u{0440}", "\u{0430}\u{043F}\u{0440}", "\u{043C}\u{0430}\u{0439}", "\u{0438}\u{044E}\u{043D}", "\u{0438}\u{044E}\u{043B}", "\u{0430}\u{0432}\u{0433}", "\u{0441}\u{0435}\u{043D}", "\u{043E}\u{043A}\u{0442}", "\u{043D}\u{043E}\u{044F}", "\u{0434}\u{0435}\u{043A}"],
    days_full: ["\u{0432}\u{043E}\u{0441}\u{043A}\u{0440}\u{0435}\u{0441}\u{0435}\u{043D}\u{044C}\u{0435}", "\u{043F}\u{043E}\u{043D}\u{0435}\u{0434}\u{0435}\u{043B}\u{044C}\u{043D}\u{0438}\u{043A}", "\u{0432}\u{0442}\u{043E}\u{0440}\u{043D}\u{0438}\u{043A}", "\u{0441}\u{0440}\u{0435}\u{0434}\u{0430}", "\u{0447}\u{0435}\u{0442}\u{0432}\u{0435}\u{0440}\u{0433}", "\u{043F}\u{044F}\u{0442}\u{043D}\u{0438}\u{0446}\u{0430}", "\u{0441}\u{0443}\u{0431}\u{0431}\u{043E}\u{0442}\u{0430}"],
    days_short: ["\u{0432}\u{0441}", "\u{043F}\u{043D}", "\u{0432}\u{0442}", "\u{0441}\u{0440}", "\u{0447}\u{0442}", "\u{043F}\u{0442}", "\u{0441}\u{0431}"],
};

impl CalendarNames {
    /// Month name for a 1-based month number; out-of-range yields "???" the
    /// same way the engine's old English-only table did.
    pub fn month_full(&self, month: u32) -> &'static str {
        self.months_full.get(month.wrapping_sub(1) as usize).copied().unwrap_or("???")
    }
    pub fn month_short(&self, month: u32) -> &'static str {
        self.months_short.get(month.wrapping_sub(1) as usize).copied().unwrap_or("???")
    }
    /// 0 = Sunday.
    pub fn day_full(&self, dow: u32) -> &'static str {
        self.days_full.get(dow as usize).copied().unwrap_or("???")
    }
    pub fn day_short(&self, dow: u32) -> &'static str {
        self.days_short.get(dow as usize).copied().unwrap_or("???")
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

    /// Excel's ribbon Long Date / Time entries write `[$-x-sysdate]` /
    /// `[$-x-systime]`, i.e. "use the OS pattern". Before these two fields
    /// existed there was NO long-date and NO time pattern anywhere in the app,
    /// in any language, so those two dropdown entries could only have shipped
    /// a hard-coded US pattern.
    #[test]
    fn every_supported_locale_carries_a_long_date_and_a_time_pattern() {
        for (id, _) in LocaleSettings::supported_locales() {
            let locale = LocaleSettings::from_locale_id(&id);
            assert!(
                !locale.long_date_format.is_empty(),
                "{} has no long date pattern",
                id
            );
            assert!(!locale.time_format.is_empty(), "{} has no time pattern", id);
            // A long date is only "long" if it spells the month out -- except
            // in the CJK locales, whose OS long date is genuinely numeric with
            // literal year/month/day markers (Windows ja-JP SLONGDATE is
            // `yyyy'年'M'月'd'日'`). Asserting "mmmm" for those would be
            // inventing a pattern Excel does not use there.
            let cjk = matches!(&id[..2], "ja" | "zh" | "ko");
            assert!(
                cjk || locale.long_date_format.to_lowercase().contains("mmmm"),
                "{} long date is not a long date: {}",
                id,
                locale.long_date_format
            );
            // "With seconds" is what makes it the LONG time pattern.
            assert!(
                locale.time_format.to_lowercase().contains("ss"),
                "{} time pattern has no seconds: {}",
                id,
                locale.time_format
            );
        }
    }

    #[test]
    fn swedish_long_date_and_time_match_the_os_patterns() {
        let locale = LocaleSettings::from_locale_id("sv-SE");
        assert_eq!(locale.long_date_format, "\"den \"d mmmm yyyy");
        assert_eq!(locale.time_format, "hh:mm:ss");
        // sv-SE has no AM/PM designator; a 12-hour pattern here would be wrong.
        assert!(!locale.time_format.contains("AM/PM"));
    }

    #[test]
    fn us_long_date_and_time_match_the_os_patterns() {
        let locale = LocaleSettings::invariant();
        assert_eq!(locale.long_date_format, "dddd, mmmm d, yyyy");
        assert_eq!(locale.time_format, "h:mm:ss AM/PM");
    }

    /// The month/weekday tokens are LANGUAGE tokens. An English-only table
    /// would have rendered Excel's Long Date as "den 15 January 2024" on the
    /// app's own sv-SE test locale.
    #[test]
    fn calendar_names_are_localized_per_language() {
        let se = LocaleSettings::from_locale_id("sv-SE");
        assert_eq!(se.calendar().month_full(1), "januari");
        assert_eq!(se.calendar().month_short(10), "okt");
        assert_eq!(se.calendar().day_full(1), "m\u{00E5}ndag");

        let us = LocaleSettings::invariant();
        assert_eq!(us.calendar().month_full(1), "January");
        assert_eq!(us.calendar().day_full(0), "Sunday");

        // en-GB shares the English table (language-part dispatch).
        let gb = LocaleSettings::from_locale_id("en-GB");
        assert_eq!(gb.calendar().month_full(12), "December");

        // Unknown language falls back to English, like from_locale_id itself.
        let unknown = LocaleSettings {
            locale_id: "xx-XX".to_string(),
            ..LocaleSettings::invariant()
        };
        assert_eq!(unknown.calendar().month_full(3), "March");
    }

    #[test]
    fn calendar_tables_are_complete_and_out_of_range_is_safe() {
        for (id, _) in LocaleSettings::supported_locales() {
            let cal = LocaleSettings::from_locale_id(&id).calendar();
            for m in 1..=12u32 {
                assert!(!cal.month_full(m).is_empty(), "{} month {}", id, m);
                assert!(!cal.month_short(m).is_empty(), "{} month {}", id, m);
            }
            for d in 0..7u32 {
                assert!(!cal.day_full(d).is_empty(), "{} day {}", id, d);
                assert!(!cal.day_short(d).is_empty(), "{} day {}", id, d);
            }
            assert_eq!(cal.month_full(0), "???");
            assert_eq!(cal.month_full(13), "???");
            assert_eq!(cal.day_full(7), "???");
        }
    }
}
