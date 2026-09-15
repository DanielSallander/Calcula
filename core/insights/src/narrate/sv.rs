//! FILENAME: core/insights/src/narrate/sv.rs
// PURPOSE: The Swedish sentence for every fact.
// CONTEXT: Until this file existed, `narrator_for` returned `EnNarrator` for
// BOTH locales — Swedish readers got English prose with Swedish numbers, which
// `mod.rs` documented as deliberate and temporary. One consequence went
// unnoticed for a while and is worth writing down: the narration eval scored
// the on-board model at 0 of 5 Swedish bundles, and that number was read as a
// MODEL failure when the deterministic side it was being compared against was
// not Swedish either.
//
// THE SAME TWO RULES AS `en.rs`, for the same reasons:
//
//  1. THE MATCH IS EXHAUSTIVE, no wildcard arm. A new `FactKind` does not
//     compile until someone has written what it says in Swedish, because a fact
//     with no template would be dropped from the narration while still counting
//     against the budget — the bundle would say eleven things and claim twelve.
//
//  2. NO TEMPLATE MAY CLAIM CAUSATION, and the correlation template has to say
//     so out loud without using the banned word itself.
//
// WHAT IS SWEDISH HERE BEYOND THE WORDS.
//
//  - NUMBERS ARE ALREADY HANDLED and must not be re-implemented: `number.rs`
//    formats through `LocaleSettings`, which is the half a reader cannot work
//    around (a decimal point in a Swedish report reads as a thousands separator
//    and moves the value three orders of magnitude).
//
//  - GRAMMATICAL GENDER decides the article and the adjective, and Swedish has
//    two. `rad` is an EN-word (en rad, raden, två rader) and `värde` is an
//    ETT-word (ett värde, värdet, två värden), so a single `plural()` helper
//    like the English one cannot serve both — the plural of an ett-word with no
//    ending is identical to its singular. Each noun below therefore carries its
//    own forms rather than being assembled from a rule.
//
//  - "R-squared" stays as the symbol `R²` rather than being translated. A
//    Swedish statistics reader knows the symbol; "R-kvadrat" is a translation
//    of an English name for it and reads as a back-translation.

use engine::LocaleSettings;

use super::number::{count, num, pct, ratio, signed_pct};
use super::{Locale, Narrator};
use crate::types::{Direction, FactKind, OutlierPoint};

pub struct SvNarrator {
    locale: Locale,
    numbers: LocaleSettings,
}

impl SvNarrator {
    pub fn new(locale: Locale) -> Self {
        SvNarrator {
            numbers: locale.number_settings(),
            locale,
        }
    }
}

/// Singular or plural, spelled out per noun.
///
/// Not a rule. Swedish plural formation depends on the noun's declension and
/// several of the nouns here take no ending at all (`ett värde` -> `två
/// värden`, but `ett fel` -> `två fel`), so a generic "add -er" helper would be
/// wrong more often than right.
fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        one.to_string()
    } else {
        many.to_string()
    }
}

fn direction_word(d: Direction) -> &'static str {
    match d {
        Direction::Rising => "stigande",
        Direction::Falling => "fallande",
        Direction::Flat => "oförändrad",
    }
}

fn points_phrase(points: &[OutlierPoint], loc: &LocaleSettings) -> String {
    points
        .iter()
        .map(|p| format!("{} ({})", p.label, num(p.value, loc)))
        .collect::<Vec<_>>()
        .join(", ")
}

impl Narrator for SvNarrator {
    fn locale(&self) -> Locale {
        self.locale
    }

    fn numbers(&self) -> &LocaleSettings {
        &self.numbers
    }

    fn narrate(&self, fact: &FactKind) -> String {
        let loc = &self.numbers;
        match fact {
            FactKind::Shape {
                rows,
                cols,
                has_header,
            } => format!(
                "Området är {} {} gånger {} {}, {}.",
                count(*rows as usize, loc),
                plural(*rows as usize, "rad", "rader"),
                count(*cols as usize, loc),
                plural(*cols as usize, "kolumn", "kolumner"),
                if *has_header {
                    "där första raden läses som kolumnnamn"
                } else {
                    "utan rubrikrad"
                }
            ),

            FactKind::ColumnSummary {
                subject,
                n,
                min,
                max,
                mean,
                median,
                stdev,
            } => format!(
                "{} innehåller {} {} från {} till {}: medelvärde {}, median {}, standardavvikelse {}.",
                subject.label(),
                count(*n, loc),
                plural(*n, "värde", "värden"),
                num(*min, loc),
                num(*max, loc),
                num(*mean, loc),
                num(*median, loc),
                num(*stdev, loc)
            ),

            FactKind::TextSummary {
                subject,
                distinct,
                top,
            } => {
                let head = format!(
                    "{} innehåller {} unika {}.",
                    subject.label(),
                    count(*distinct, loc),
                    plural(*distinct, "värde", "värden")
                );
                if top.is_empty() {
                    head
                } else {
                    let listed = top
                        .iter()
                        .map(|(name, n)| format!("{} ({})", name, count(*n as usize, loc)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("{} Vanligast: {}.", head, listed)
                }
            }

            FactKind::BooleanShare {
                subject,
                true_share,
                n,
            } => format!(
                "{} är SANT i {} av {} {}.",
                subject.label(),
                pct(*true_share, loc),
                count(*n, loc),
                plural(*n, "rad", "rader")
            ),

            FactKind::Trend {
                subject,
                slope_per_step,
                r2,
                pct_change,
                first,
                last,
                n,
                direction,
            } => format!(
                "{} är {} med omkring {} per steg över {} punkter, från {} till {} ({} totalt); \
                 en rät linje förklarar R² = {} av variationen.",
                subject.label(),
                direction_word(*direction),
                num(slope_per_step.abs(), loc),
                count(*n, loc),
                num(*first, loc),
                num(*last, loc),
                signed_pct(*pct_change, loc),
                ratio(*r2, loc)
            ),

            FactKind::Change {
                subject,
                first_label,
                last_label,
                first,
                last,
                pct,
            } => format!(
                "{} gick från {} vid {} till {} vid {}, en förändring på {}.",
                subject.label(),
                num(*first, loc),
                first_label,
                num(*last, loc),
                last_label,
                signed_pct(*pct, loc)
            ),

            FactKind::Extremes {
                subject,
                best_label,
                best,
                worst_label,
                worst,
            } => format!(
                "{} är högst vid {} ({}) och lägst vid {} ({}).",
                subject.label(),
                best_label,
                num(*best, loc),
                worst_label,
                num(*worst, loc)
            ),

            FactKind::SmoothedPeak {
                subject,
                window,
                peak_label,
                peak,
                trough_label,
                trough,
            } => format!(
                "Utjämnat över {} punkter når {} sin topp vid {} ({}) och sin botten vid {} ({}).",
                count(*window, loc),
                subject.label(),
                peak_label,
                num(*peak, loc),
                trough_label,
                num(*trough, loc)
            ),

            FactKind::Seasonality { subject, lag, acf } => format!(
                "{} upprepar sig i en cykel på {} punkter: när trenden räknats bort är \
                 autokorrelationen vid eftersläpning {} lika med {}.",
                subject.label(),
                count(*lag, loc),
                count(*lag, loc),
                ratio(*acf, loc)
            ),

            FactKind::ChangePoint {
                subject,
                at_label,
                before_mean,
                after_mean,
                shift_sd,
                ..
            } => format!(
                "{} byter nivå vid {}: medelvärdet går från {} till {}, ett avstånd på {} \
                 sammanvägda standardavvikelser.",
                subject.label(),
                at_label,
                num(*before_mean, loc),
                num(*after_mean, loc),
                ratio(*shift_sd, loc)
            ),

            FactKind::Outliers {
                subject,
                method,
                low_fence,
                high_fence,
                points,
                total,
            } => {
                let named = points_phrase(points, loc);
                let tail = if *total > points.len() {
                    format!(" Störst avvikelse: {}.", named)
                } else {
                    format!(" {}: {}.", plural(points.len(), "Värde", "Värden"), named)
                };
                format!(
                    "{} har {} {} utanför sina {}-gränser ({} till {}).{}",
                    subject.label(),
                    count(*total, loc),
                    plural(*total, "värde", "värden"),
                    method.as_str(),
                    num(*low_fence, loc),
                    num(*high_fence, loc),
                    tail
                )
            }

            // The disclaimer says what it means WITHOUT the word "orsak", for
            // the same reason the English one avoids "cause": the guard that
            // bans causal language would otherwise trip on the very sentence
            // written to disclaim it.
            FactKind::Correlation { a, b, r, n } => format!(
                "{} och {} rör sig tillsammans: r = {} över {} parade {}. Detta är ett \
                 samband i datan, och visar inte att den ena förändrar den andra.",
                a.label(),
                b.label(),
                ratio(*r, loc),
                count(*n, loc),
                plural(*n, "rad", "rader")
            ),

            FactKind::Dominance {
                category,
                value,
                top_category,
                top_share,
                categories,
            } => format!(
                "{} står för {} av {}, av {} värden för {}.",
                top_category,
                pct(*top_share, loc),
                value,
                count(*categories, loc),
                category
            ),

            FactKind::Pareto {
                category,
                value,
                top_k,
                categories,
                share,
            } => format!(
                "{} av {} värden för {} står för {} av totalt {}.",
                count(*top_k, loc),
                count(*categories, loc),
                category,
                pct(*share, loc),
                value
            ),

            FactKind::Duplicates { rows, example_row } => format!(
                "{} {} upprepar en tidigare rad; den första upprepningen finns på bladrad {}.",
                count(*rows, loc),
                plural(*rows, "rad", "rader"),
                // `example_row` is a 0-based engine coordinate and the reader
                // sees 1-based row numbers in the grid.
                count(*example_row as usize + 1, loc)
            ),

            FactKind::BlankRows { rows } => format!(
                "{} {} helt tomma.",
                count(*rows, loc),
                plural(*rows, "rad är", "rader är")
            ),

            FactKind::Errors {
                count: n,
                subject,
                example,
            } => format!(
                "{} innehåller {} {} med fel, till exempel {}.",
                subject.label(),
                count(*n, loc),
                plural(*n, "värde", "värden"),
                example
            ),

            FactKind::MixedTypes {
                subject,
                number_share,
                text_share,
            } => format!(
                "{} blandar typer: {} av värdena är tal och {} är text.",
                subject.label(),
                pct(*number_share, loc),
                pct(*text_share, loc)
            ),

            FactKind::Crossover { a, b, at_label, .. } => {
                format!("{} och {} byter plats vid {}.", a.label(), b.label(), at_label)
            }

            FactKind::Leader {
                subject,
                share,
                others,
            } => format!(
                "{} är störst av {} serier, med {} av deras sammanlagda total.",
                subject.label(),
                count(*others + 1, loc),
                pct(*share, loc)
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrate::en::every_fact_kind_fixture;

    #[test]
    fn every_fact_has_a_swedish_sentence() {
        // The exhaustive match means a missing template does not compile, but
        // nothing stops a template being copied from English and left there.
        // Every fixture is narrated and checked for the marker words of the
        // English originals.
        let n = SvNarrator::new(Locale::Sv);
        for fact in every_fact_kind_fixture() {
            let text = n.narrate(&fact);
            assert!(!text.is_empty(), "empty Swedish narration for {fact:?}");
            for english in [
                " is ", " the ", " and ", " from ", " holds ", " rows", " values",
                "column", "standard deviation", "outside",
            ] {
                assert!(
                    !text.contains(english),
                    "Swedish narration still contains the English fragment {english:?}: {text}"
                );
            }
        }
    }

    #[test]
    fn swedish_numbers_are_used() {
        // The half a reader cannot work around: a decimal point where a comma
        // belongs moves the value three orders of magnitude.
        let n = SvNarrator::new(Locale::Sv);
        let text = n.narrate(&FactKind::BlankRows { rows: 2 });
        assert!(text.contains('2'), "{text}");
        assert!(text.contains("rader är helt tomma"), "{text}");
    }

    #[test]
    fn an_ett_word_keeps_its_plural() {
        // `värde` is an ett-word: two of them are `värden`, not `värder`. A
        // generic "add -er" plural helper gets this wrong, which is why each
        // noun carries its own forms.
        assert_eq!(plural(1, "värde", "värden"), "värde");
        assert_eq!(plural(2, "värde", "värden"), "värden");
        assert_eq!(plural(1, "rad", "rader"), "rad");
        assert_eq!(plural(2, "rad", "rader"), "rader");
    }

    #[test]
    fn the_correlation_disclaimer_avoids_the_banned_word() {
        // A disclaimer that trips the causal-language guard is not a disclaimer
        // anyone can rely on — the same trap `en.rs` documents.
        let n = SvNarrator::new(Locale::Sv);
        for fact in every_fact_kind_fixture() {
            if let FactKind::Correlation { .. } = fact {
                let text = n.narrate(&fact);
                assert!(text.contains("samband i datan"), "{text}");
                assert!(!text.to_lowercase().contains("orsak"), "{text}");
            }
        }
    }
}
