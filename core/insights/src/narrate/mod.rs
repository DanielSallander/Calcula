//! FILENAME: core/insights/src/narrate/mod.rs
// PURPOSE: Turn a fact into a sentence, in the reader's language.
// CONTEXT: Narration is the LAST step and the only one that produces prose.
// Facts carry numbers; a narrator is one consumer of those numbers and a later
// model-written paragraph will be another, working from the same `facts_json`
// rather than paraphrasing what is written here.

pub mod cite;
pub mod en;
pub mod number;
pub mod prompt;

use engine::LocaleSettings;
use serde::{Deserialize, Serialize};

use crate::types::FactKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Locale {
    En,
    Sv,
}

impl Locale {
    pub fn locale_id(self) -> &'static str {
        match self {
            Locale::En => "en-US",
            Locale::Sv => "sv-SE",
        }
    }

    /// Anything that is not recognisably Swedish narrates in English. Guessing
    /// wrong toward English produces a readable sentence; guessing wrong toward
    /// a language we do not have templates for produces nothing at all.
    pub fn from_locale_id(id: &str) -> Locale {
        let lower = id.replace('_', "-").to_lowercase();
        if lower == "sv" || lower.starts_with("sv-") {
            Locale::Sv
        } else {
            Locale::En
        }
    }

    /// The number-formatting settings this locale reads numbers in. Separate
    /// from the template language on purpose -- see `narrator_for`.
    pub fn number_settings(self) -> LocaleSettings {
        LocaleSettings::from_locale_id(self.locale_id())
    }
}

pub trait Narrator {
    fn locale(&self) -> Locale;
    fn numbers(&self) -> &LocaleSettings;
    fn narrate(&self, fact: &FactKind) -> String;
}

/// The narrator for a locale.
///
/// Swedish got the ENGLISH templates with Swedish numbers until 2026-09-15,
/// ENGLISH PROSE FOR EVERY LOCALE, BY DECISION — not by omission.
///
/// A Swedish narrator was written on 2026-09-15 and REMOVED the same day, when
/// the owner scoped the AI programme to English only. Do not write it back
/// without that decision being revisited: the `narrate` match is exhaustive
/// with no wildcard arm, so a second language is a permanent tax — every future
/// `FactKind` must then be worded twice, forever, or the crate stops compiling.
///
/// WHAT THIS DOES **NOT** MEAN. The NUMBERS stay localised, and that is not the
/// same question. `number.rs` formats through `LocaleSettings`, so a Swedish
/// reader still gets `1 234,50` rather than `1,234.50` — a decimal point where
/// a comma belongs reads as a thousands separator and moves the value three
/// orders of magnitude. Prose in the wrong language is inconvenient; a number
/// in the wrong format is wrong.
pub fn narrator_for(locale: Locale) -> Box<dyn Narrator> {
    Box::new(en::EnNarrator::new(locale))
}

/// The narrator for the app locale `settings`: English prose (as above) with
/// THESE settings' digits and separators, for every locale. `narrator_for`
/// collapses every non-Swedish locale to en-US numbers (`number_settings`),
/// so a de-DE reader read "1,234.50" -- a value off by three orders of
/// magnitude to a German eye (P2 A15).
pub fn narrator_for_settings(settings: &LocaleSettings) -> Box<dyn Narrator> {
    Box::new(en::EnNarrator::with_numbers(settings.clone()))
}

pub fn narrator_for_locale_id(id: &str) -> Box<dyn Narrator> {
    narrator_for(Locale::from_locale_id(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_swedish_narrator_uses_swedish_numbers() {
        let n = narrator_for(Locale::Sv);
        assert_eq!(n.locale(), Locale::Sv);
        assert_eq!(n.numbers().decimal_separator, ',');
        assert_eq!(number::num(1234.5, n.numbers()), "1\u{00A0}234,5");
    }

    fn change_fact() -> FactKind {
        FactKind::Change {
            subject: crate::types::Subject::measure("Revenue"),
            first_label: "Jan".to_string(),
            last_label: "Dec".to_string(),
            first: 1234.5,
            last: 12.5,
            pct: -0.5,
        }
    }

    /// P2 A15: the narrator for the APP locale's settings writes that
    /// locale's digits for EVERY locale -- de-DE included, which
    /// `narrator_for` collapses to en-US numbers -- while the prose stays
    /// English.
    #[test]
    fn a_settings_narrator_writes_every_locales_numbers_in_english_prose() {
        let de = narrator_for_settings(&LocaleSettings::from_locale_id("de-DE"));
        assert_eq!(de.locale(), Locale::En, "a de-DE reader got non-English prose");
        let text = de.narrate(&change_fact());
        assert!(text.contains("1.234,5"), "{text}");
        assert!(text.contains("12,50"), "{text}");
        assert!(text.starts_with("Revenue moved from"), "{text}");

        // The collapse this replaces: the same fact read "1,234.5" for de-DE.
        let collapsed = narrator_for_locale_id("de-DE").narrate(&change_fact());
        assert!(collapsed.contains("1,234.5"), "{collapsed}");

        // en-US and sv-SE are unchanged by the move.
        let en = narrator_for_settings(&LocaleSettings::invariant()).narrate(&change_fact());
        assert_eq!(en, narrator_for(Locale::En).narrate(&change_fact()));
        let sv_settings = LocaleSettings::from_locale_id("sv-SE");
        let sv = narrator_for_settings(&sv_settings);
        assert_eq!(sv.locale(), Locale::Sv);
        assert_eq!(sv.narrate(&change_fact()), narrator_for(Locale::Sv).narrate(&change_fact()));
    }

    #[test]
    fn an_unknown_locale_id_narrates_in_english_rather_than_not_at_all() {
        assert_eq!(Locale::from_locale_id("de-DE"), Locale::En);
        assert_eq!(Locale::from_locale_id("sv"), Locale::Sv);
        assert_eq!(Locale::from_locale_id("sv_SE"), Locale::Sv);
        assert_eq!(Locale::from_locale_id("SV-se"), Locale::Sv);
        assert_eq!(narrator_for_locale_id("").locale(), Locale::En);
    }
}
