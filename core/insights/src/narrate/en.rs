//! FILENAME: core/insights/src/narrate/en.rs
// PURPOSE: The English sentence for every fact.
// CONTEXT: The `match` in `narrate` is EXHAUSTIVE with no wildcard arm, so a
// new `FactKind` variant does not compile until someone has written what it
// says. That is the point of the file: a fact with no template would otherwise
// be silently dropped from the narration while still counting against the
// budget, and the bundle would say eleven things and claim twelve.
//
// NO TEMPLATE MAY CLAIM CAUSATION. `no_template_uses_causal_language` below
// enforces it over every variant. The correlation template in particular has to
// say out loud that it is an association -- and it says so WITHOUT the word
// "cause", because that word is on the banned list and a disclaimer that trips
// its own guard is not a disclaimer anyone can rely on.

use engine::LocaleSettings;

use super::number::{count, num, pct, ratio, signed_pct};
use super::{Locale, Narrator};
use crate::types::{Direction, FactKind, OutlierPoint};

pub struct EnNarrator {
    locale: Locale,
    numbers: LocaleSettings,
}

impl EnNarrator {
    pub fn new(locale: Locale) -> Self {
        EnNarrator {
            numbers: locale.number_settings(),
            locale,
        }
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        one.to_string()
    } else {
        many.to_string()
    }
}

fn direction_word(d: Direction) -> &'static str {
    match d {
        Direction::Rising => "rising",
        Direction::Falling => "falling",
        Direction::Flat => "level",
    }
}

fn points_phrase(points: &[OutlierPoint], loc: &LocaleSettings) -> String {
    points
        .iter()
        .map(|p| format!("{} ({})", p.label, num(p.value, loc)))
        .collect::<Vec<_>>()
        .join(", ")
}

impl Narrator for EnNarrator {
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
                "The range is {} {} by {} {}, {}.",
                count(*rows as usize, loc),
                plural(*rows as usize, "row", "rows"),
                count(*cols as usize, loc),
                plural(*cols as usize, "column", "columns"),
                if *has_header {
                    "with the first row read as column names"
                } else {
                    "with no header row"
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
                "{} holds {} {} from {} to {}: mean {}, median {}, standard deviation {}.",
                subject.label(),
                count(*n, loc),
                plural(*n, "value", "values"),
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
                    "{} holds {} distinct {}.",
                    subject.label(),
                    count(*distinct, loc),
                    plural(*distinct, "value", "values")
                );
                if top.is_empty() {
                    head
                } else {
                    let listed = top
                        .iter()
                        .map(|(name, n)| format!("{} ({})", name, count(*n as usize, loc)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("{} Most frequent: {}.", head, listed)
                }
            }

            FactKind::BooleanShare {
                subject,
                true_share,
                n,
            } => format!(
                "{} is TRUE in {} of {} {}.",
                subject.label(),
                pct(*true_share, loc),
                count(*n, loc),
                plural(*n, "row", "rows")
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
                "{} is {} by about {} per step over {} points, from {} to {} ({} overall); \
                 a straight-line fit accounts for R-squared = {} of the variation.",
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
                "{} moved from {} at {} to {} at {}, a change of {}.",
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
                ..
            } => format!(
                "{} is highest at {} ({}) and lowest at {} ({}).",
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
                ..
            } => format!(
                "Smoothed over {} points, {} peaks at {} ({}) and bottoms out at {} ({}).",
                count(*window, loc),
                subject.label(),
                peak_label,
                num(*peak, loc),
                trough_label,
                num(*trough, loc)
            ),

            FactKind::Seasonality { subject, lag, acf } => format!(
                "{} repeats on a {}-point cycle: after the trend is removed, its \
                 autocorrelation at lag {} is {}.",
                subject.label(),
                count(*lag, loc),
                count(*lag, loc),
                ratio(*acf, loc)
            ),

            // `at_index` is evidence for a caller that wants to highlight the
            // point on a chart; the sentence names the LABEL, which is what the
            // reader sees on the axis.
            FactKind::ChangePoint {
                subject,
                at_label,
                before_mean,
                after_mean,
                shift_sd,
                ..
            } => format!(
                "{} shifts level at {}: the mean moves from {} to {}, a gap of {} pooled \
                 standard deviations.",
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
                    format!(" Furthest: {}.", named)
                } else {
                    format!(" {}: {}.", plural(points.len(), "Value", "Values"), named)
                };
                format!(
                    "{} has {} {} outside its {} fences ({} to {}).{}",
                    subject.label(),
                    count(*total, loc),
                    plural(*total, "value", "values"),
                    method.as_str(),
                    num(*low_fence, loc),
                    num(*high_fence, loc),
                    tail
                )
            }

            FactKind::Correlation { a, b, r, n } => format!(
                "{} and {} move together: r = {} over {} paired {}. This is an association \
                 in the data only, and does not establish that one of them changes the other.",
                a.label(),
                b.label(),
                ratio(*r, loc),
                count(*n, loc),
                plural(*n, "row", "rows")
            ),

            FactKind::Dominance {
                category,
                value,
                top_category,
                top_share,
                categories,
                ..
            } => format!(
                "{} accounts for {} of {}, out of {} {} values.",
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
                ..
            } => format!(
                "{} of {} {} values account for {} of total {}.",
                count(*top_k, loc),
                count(*categories, loc),
                category,
                pct(*share, loc),
                value
            ),

            FactKind::Duplicates { rows, example_row } => format!(
                "{} {} repeat an earlier row; the first repeat is at sheet row {}.",
                count(*rows, loc),
                plural(*rows, "row", "rows"),
                // `example_row` is a 0-based engine coordinate and the user
                // reads 1-based row numbers off the grid.
                count(*example_row as usize + 1, loc)
            ),

            FactKind::BlankRows { rows } => format!(
                "{} {} entirely blank.",
                count(*rows, loc),
                plural(*rows, "row is", "rows are")
            ),

            FactKind::Errors {
                count: n,
                subject,
                example,
            } => format!(
                "{} holds {} error {}, for example {}.",
                subject.label(),
                count(*n, loc),
                plural(*n, "value", "values"),
                example
            ),

            FactKind::MixedTypes {
                subject,
                number_share,
                text_share,
            } => format!(
                "{} mixes types: {} of its values are numbers and {} are text.",
                subject.label(),
                pct(*number_share, loc),
                pct(*text_share, loc)
            ),

            FactKind::Crossover { a, b, at_label, .. } => {
                format!("{} and {} swap places at {}.", a.label(), b.label(), at_label)
            }

            FactKind::Leader {
                subject,
                share,
                others,
            } => format!(
                "{} is the largest of {} series, at {} of their combined total.",
                subject.label(),
                count(*others + 1, loc),
                pct(*share, loc)
            ),
        }
    }
}

/// One instance of EVERY `FactKind` variant, for tests that must cover the
/// whole enum. Public within the crate so `lib.rs` can reuse it.
#[cfg(test)]
pub(crate) fn every_fact_kind_fixture() -> Vec<FactKind> {
    use crate::types::{OutlierMethod, RangeRef, Subject};

    let col = Subject::column("Revenue", "Sales", RangeRef::new("Sales", 1, 1, 12, 1));
    let other = Subject::column("Spend", "Sales", RangeRef::new("Sales", 1, 2, 12, 2));

    vec![
        FactKind::Shape {
            rows: 12,
            cols: 4,
            has_header: true,
        },
        FactKind::ColumnSummary {
            subject: col.clone(),
            n: 12,
            min: 10.0,
            max: 90.0,
            mean: 45.5,
            median: 44.0,
            stdev: 22.25,
        },
        FactKind::TextSummary {
            subject: other.clone(),
            distinct: 5,
            top: vec![("North".to_string(), 9), ("South".to_string(), 4)],
        },
        FactKind::BooleanShare {
            subject: col.clone(),
            true_share: 0.625,
            n: 16,
        },
        FactKind::Trend {
            subject: col.clone(),
            slope_per_step: 3.25,
            r2: 0.91,
            pct_change: 0.42,
            first: 100.0,
            last: 142.0,
            n: 12,
            direction: Direction::Rising,
        },
        FactKind::Change {
            subject: col.clone(),
            first_label: "Jan".to_string(),
            last_label: "Dec".to_string(),
            first: 100.0,
            last: 142.0,
            pct: 0.42,
        },
        FactKind::Extremes {
            subject: col.clone(),
            best_label: "Aug".to_string(),
            best_index: 7,
            best: 190.0,
            worst_label: "Feb".to_string(),
            worst_index: 1,
            worst: 61.0,
        },
        FactKind::SmoothedPeak {
            subject: col.clone(),
            window: 3,
            peak_label: "Jul".to_string(),
            peak_index: 6,
            peak: 175.5,
            trough_label: "Feb".to_string(),
            trough_index: 1,
            trough: 64.0,
        },
        FactKind::Seasonality {
            subject: col.clone(),
            lag: 12,
            acf: 0.81,
        },
        FactKind::ChangePoint {
            subject: col.clone(),
            at_label: "Jul".to_string(),
            at_index: 6,
            before_mean: 101.0,
            after_mean: 148.0,
            shift_sd: 3.4,
        },
        FactKind::Outliers {
            subject: col.clone(),
            method: OutlierMethod::Iqr,
            low_fence: 20.0,
            high_fence: 180.0,
            points: vec![OutlierPoint {
                index: 7,
                label: "Aug".to_string(),
                value: 400.0,
                z: 4.1,
            }],
            total: 1,
        },
        FactKind::Correlation {
            a: col.clone(),
            b: other.clone(),
            r: 0.87,
            n: 12,
        },
        FactKind::Dominance {
            category: "Region".to_string(),
            value: "Revenue".to_string(),
            top_category: "North".to_string(),
            top_index: Some(0),
            top_share: 0.62,
            categories: 5,
        },
        FactKind::Pareto {
            category: "Product".to_string(),
            value: "Revenue".to_string(),
            top_k: 2,
            categories: 10,
            share: 0.83,
            // One member with a single row, one summed across several: the
            // TypeScript rule must place the first and refuse the second.
            top_categories: vec!["Gadgets".to_string(), "Widgets".to_string()],
            top_indices: vec![Some(3), None],
        },
        FactKind::Duplicates {
            rows: 3,
            example_row: 11,
        },
        FactKind::BlankRows { rows: 2 },
        FactKind::Errors {
            count: 4,
            subject: col.clone(),
            example: "#DIV/0!".to_string(),
        },
        FactKind::MixedTypes {
            subject: col.clone(),
            number_share: 0.7,
            text_share: 0.3,
        },
        FactKind::Crossover {
            a: col.clone(),
            b: other,
            at_label: "Jun".to_string(),
            at_index: 5,
        },
        FactKind::Leader {
            subject: col,
            share: 0.55,
            others: 3,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ALL_KIND_KEYS;
    use std::collections::BTreeSet;

    /// Words and phrases that assert one thing made another thing happen. The
    /// statistics in this crate cannot support any of them.
    const CAUSAL_LANGUAGE: &[&str] = &[
        "because",
        "cause",
        "caused",
        "due to",
        "leads to",
        "drives",
        "driven by",
        "results in",
        "effect of",
        "explains",
        "thanks to",
    ];

    #[test]
    fn no_template_uses_causal_language() {
        let narrator = EnNarrator::new(Locale::En);
        for fact in every_fact_kind_fixture() {
            let text = narrator.narrate(&fact).to_lowercase();
            for banned in CAUSAL_LANGUAGE {
                assert!(
                    !text.contains(banned),
                    "{} narrates with causal language {:?}: {}",
                    fact.kind_key(),
                    banned,
                    text
                );
            }
        }
    }

    #[test]
    fn every_fact_kind_has_a_fixture() {
        // Without this, a new variant could be added, given a template, and
        // never exercised by the causal-language guard above.
        let covered: BTreeSet<&str> = every_fact_kind_fixture()
            .iter()
            .map(|f| f.kind_key())
            .collect();
        let declared: BTreeSet<&str> = ALL_KIND_KEYS.iter().copied().collect();
        assert_eq!(covered, declared);
    }

    #[test]
    fn every_template_produces_a_finished_sentence() {
        let narrator = EnNarrator::new(Locale::En);
        for fact in every_fact_kind_fixture() {
            let text = narrator.narrate(&fact);
            assert!(!text.is_empty(), "{} narrated to nothing", fact.kind_key());
            assert!(
                text.ends_with('.'),
                "{} does not end in a full stop: {}",
                fact.kind_key(),
                text
            );
            assert!(
                !text.contains("NaN") && !text.contains("inf"),
                "{} leaked a raw float: {}",
                fact.kind_key(),
                text
            );
        }
    }

    #[test]
    fn the_correlation_template_says_it_is_an_association() {
        let narrator = EnNarrator::new(Locale::En);
        let fact = every_fact_kind_fixture()
            .into_iter()
            .find(|f| f.kind_key() == "correlation")
            .unwrap();
        let text = narrator.narrate(&fact);
        assert!(text.contains("association"), "{text}");
        assert!(text.contains("does not establish"), "{text}");
    }

    #[test]
    fn narration_is_byte_identical_across_runs() {
        let narrator = EnNarrator::new(Locale::En);
        let first: Vec<String> = every_fact_kind_fixture()
            .iter()
            .map(|f| narrator.narrate(f))
            .collect();
        for _ in 0..5 {
            let again: Vec<String> = every_fact_kind_fixture()
                .iter()
                .map(|f| narrator.narrate(f))
                .collect();
            assert_eq!(first, again);
        }
    }

    #[test]
    fn a_swedish_narrator_writes_the_numbers_with_a_comma() {
        let sv = EnNarrator::new(Locale::Sv);
        let fact = FactKind::Seasonality {
            subject: crate::types::Subject::measure("Revenue"),
            lag: 12,
            acf: 0.81,
        };
        let text = sv.narrate(&fact);
        assert!(text.contains("0,81"), "{text}");
        let en = EnNarrator::new(Locale::En);
        assert!(en.narrate(&fact).contains("0.81"));
    }

    #[test]
    fn a_single_value_is_not_narrated_in_the_plural() {
        let narrator = EnNarrator::new(Locale::En);
        let text = narrator.narrate(&FactKind::BlankRows { rows: 1 });
        assert_eq!(text, "1 row is entirely blank.");
        let many = narrator.narrate(&FactKind::BlankRows { rows: 4 });
        assert_eq!(many, "4 rows are entirely blank.");
    }
}
