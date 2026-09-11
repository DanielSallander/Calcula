//! FILENAME: core/insights/src/narrate/cite.rs
// PURPOSE: Decide whether a sentence is entitled to the numbers it prints —
//          the structural check that lets a MODEL write narration without
//          being able to invent a figure.
// CONTEXT: M6, Step 4 of the AI programme. The rule was written down long
//          before the code (`insights-strategy-layer.md` §14, "Narration stays
//          deterministic until M6"):
//
//            "every sentence tagged with the fact ids it covers, and a sentence
//             citing a number that is not in its cited facts is dropped."
//
//          This is that check. It is the reason a narrator may be a model at
//          all: the facts stay deterministic, the ranking stays deterministic,
//          and the only thing the model is trusted with is WORDING — because
//          anything else it says about a number is deleted before a reader sees
//          it.
//
// WHY IT IS IN RUST, BESIDE THE FACTS, AND NOT IN THE RENDERER
//
// Two reasons, and the second is the one that decides it.
//
//   1. The numbers and their formatting live here. A checker anywhere else
//      would have to RE-IMPLEMENT `number.rs` — every rounding rule, the
//      scientific cut-off below a thousandth, the sv-SE non-breaking space —
//      and a checker that disagrees with the formatter by one decimal place
//      deletes the engine's own correct sentences.
//   2. It is a safety check on model output. The renderer can be compromised;
//      the crate that owns the facts cannot be bypassed from there. This repo
//      fixed the same question the same way for the script interpreter, and for
//      the same reason.
//
// HOW IT AVOIDS DRIFTING FROM THE NARRATOR
//
// It never parses a number out of a sentence back into an `f64` — that is
// lossy, locale-ambiguous, and would be a second opinion about what "1 234,5"
// means. Instead it RENDERS every number the fact holds through the very
// functions the narrator uses (`num`, `count`, `pct`, `signed_pct`, `ratio`)
// and compares strings. The allowed set is therefore, by construction, exactly
// what a correct sentence about that fact can contain — and
// `the_deterministic_narrator_survives_its_own_check` proves it by running all
// twenty kinds through both.

use std::collections::BTreeSet;

use serde_json::Value;

use super::number::{count, num, pct, ratio, signed_pct};
use super::Locale;
use crate::types::{FactKind, Insight};

/// One sentence a narrator produced, with the facts it claims to be about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaggedSentence {
    pub text: String,
    pub fact_ids: Vec<String>,
}

/// Why a sentence was thrown away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropReason {
    /// It cited no fact at all. A sentence about nothing cannot be checked, so
    /// it cannot be shown.
    NoFactCited,
    /// It named a fact id that was not in the run. The narrator is choosing
    /// from a list; naming something off the list is asserting.
    UnknownFact(String),
    /// It printed a number none of its cited facts contains.
    UncitedNumber(String),
}

/// A sentence that did not survive, and what was wrong with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DroppedSentence {
    pub sentence: TaggedSentence,
    pub reason: DropReason,
}

/// What came back from checking a whole narration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrationCheck {
    /// Sentences a reader may see.
    pub kept: Vec<TaggedSentence>,
    /// Sentences deleted, each with its reason. Reported rather than silently
    /// swallowed: "the model wrote six sentences and you see two" is something
    /// a measurement has to be able to say.
    pub dropped: Vec<DroppedSentence>,
    /// Fact ids at least one surviving sentence covers.
    pub covered: BTreeSet<String>,
    /// Fact ids no surviving sentence mentions, in the order the run ranked
    /// them. This is the coverage half of the promise in `open-items.md`.
    pub uncovered: Vec<String>,
}

impl NarrationCheck {
    /// Of the facts offered, the share a surviving sentence covers.
    pub fn coverage(&self) -> f64 {
        let total = self.covered.len() + self.uncovered.len();
        if total == 0 {
            return 0.0;
        }
        self.covered.len() as f64 / total as f64
    }
}

// ---------------------------------------------------------------------------
// What a fact entitles a sentence to print
// ---------------------------------------------------------------------------

/// Every number anywhere inside a fact, found by walking its serialised form.
///
/// Generic on purpose. A hand-written match over twenty variants would have to
/// be extended for every new one, and the failure mode of forgetting is that a
/// correct sentence about the new fact gets DELETED — a silent, confusing loss
/// rather than a compile error. Walking the JSON cannot fall behind the enum.
fn numbers_in(value: &Value, out: &mut Vec<f64>) {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                out.push(f);
            }
        }
        Value::Array(items) => items.iter().for_each(|v| numbers_in(v, out)),
        Value::Object(map) => map.values().for_each(|v| numbers_in(v, out)),
        _ => {}
    }
}

/// Every string anywhere inside a fact — labels, names, method words.
///
/// Needed because a label legitimately CONTAINS digits: a change point "at Mar
/// 2024" prints 2024, which is not one of the fact's numbers but is certainly
/// in the fact. Without this the checker would delete the narrator's own
/// sentence for quoting a label back.
fn strings_in(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| strings_in(v, out)),
        Value::Object(map) => map.values().for_each(|v| strings_in(v, out)),
        _ => {}
    }
}

/// The values a template may legitimately derive from a stored one.
///
/// Small and CLOSED, and every entry earns its place from a real template:
///
///   `v`         the stored number, the overwhelming case.
///   `|v|`       Trend prints `num(slope_per_step.abs())` and the model path
///               prints `num(delta.abs())`, because the direction is already in
///               the words ("rising"/"falling") and a minus sign there would
///               read as a second negation.
///   `v + 1`     Duplicates prints `count(example_row + 1)` and Leader prints
///               `count(others + 1)`, both turning a 0-based index or an
///               exclusive count into what a person counts.
///
/// Anything a narrator wants beyond this list must be added here deliberately,
/// and the oracle test will say so by failing.
fn derived(value: f64) -> Vec<f64> {
    let mut out = vec![value, value.abs()];
    if value.fract() == 0.0 {
        out.push(value + 1.0);
    }
    out
}

/// Every string the numbers of `fact` may appear as, in `locale`.
pub fn allowed_renderings(fact: &FactKind, locale: Locale) -> BTreeSet<String> {
    let settings = locale.number_settings();
    let json = serde_json::to_value(fact).unwrap_or(Value::Null);

    let mut raw = Vec::new();
    numbers_in(&json, &mut raw);

    let mut allowed = BTreeSet::new();
    for value in raw {
        for candidate in derived(value) {
            allowed.insert(num(candidate, &settings));
            allowed.insert(pct(candidate, &settings));
            allowed.insert(signed_pct(candidate, &settings));
            allowed.insert(ratio(candidate, &settings));
            if candidate.fract() == 0.0 && candidate >= 0.0 && candidate < usize::MAX as f64 {
                allowed.insert(count(candidate as usize, &settings));
            }
        }
    }
    allowed
}

/// The number-like tokens a sentence prints, in `locale`'s spelling.
///
/// Deliberately greedy about what counts as a number: a token this misses is a
/// number nobody checks, and the whole point is that every figure a reader sees
/// has been checked. Grouping and decimal marks come from the locale, so
/// "1 234,5" is one token in Swedish and "1,234.5" is one token in English.
pub fn cited_numbers(text: &str, locale: Locale) -> Vec<String> {
    let settings = locale.number_settings();
    let decimal = settings.decimal_separator;
    let group = settings.thousands_separator;

    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // Walk back over a sign that belongs to this number.
        let start = if i > 0 && (chars[i - 1] == '+' || chars[i - 1] == '-') { i - 1 } else { i };
        let mut j = i;
        while j < chars.len() {
            let c = chars[j];
            let is_body = c.is_ascii_digit() || c == decimal || c == group;
            // Scientific notation: `1.23E-5`. The exponent's sign is part of
            // the number, not punctuation after it.
            let is_exponent = (c == 'E' || c == 'e')
                && j + 1 < chars.len()
                && (chars[j + 1].is_ascii_digit() || chars[j + 1] == '+' || chars[j + 1] == '-');
            if is_body {
                j += 1;
            } else if is_exponent {
                j += 2;
            } else {
                break;
            }
        }
        // A trailing separator is punctuation, not part of the number: "in 12,"
        while j > i && (chars[j - 1] == decimal || chars[j - 1] == group) {
            j -= 1;
        }
        let mut end = j;
        if end < chars.len() && chars[end] == '%' {
            end += 1;
        }
        out.push(chars[start..end].iter().collect::<String>());
        i = end.max(i + 1);
    }
    out
}

/// Is this token something the cited facts entitle the sentence to print?
fn entitled(token: &str, allowed: &BTreeSet<String>, labels: &[String]) -> bool {
    if allowed.contains(token) {
        return true;
    }
    // A number that is part of a label the fact carries — "Mar 2024", "Q3" —
    // is in the fact, as text.
    let bare = token.trim_start_matches(['+', '-']).trim_end_matches('%');
    labels.iter().any(|l| l.contains(token) || (!bare.is_empty() && l.contains(bare)))
}

/// Check a narration against the facts it was written from.
///
/// `facts` is the ranked run the narrator was given. A sentence survives only
/// if it cites at least one of those facts by id and every number it prints is
/// one those cited facts can account for.
pub fn check_narration(
    sentences: Vec<TaggedSentence>,
    facts: &[Insight],
    locale: Locale,
) -> NarrationCheck {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    let mut covered = BTreeSet::new();

    'sentence: for sentence in sentences {
        if sentence.fact_ids.is_empty() {
            dropped.push(DroppedSentence { sentence, reason: DropReason::NoFactCited });
            continue;
        }

        // Gather what the CITED facts — and only those — entitle it to.
        let mut allowed = BTreeSet::new();
        let mut labels = Vec::new();
        for id in &sentence.fact_ids {
            let Some(fact) = facts.iter().find(|f| &f.id == id) else {
                dropped.push(DroppedSentence {
                    sentence: sentence.clone(),
                    reason: DropReason::UnknownFact(id.clone()),
                });
                continue 'sentence;
            };
            allowed.extend(allowed_renderings(&fact.kind, locale));
            let json = serde_json::to_value(&fact.kind).unwrap_or(Value::Null);
            strings_in(&json, &mut labels);
        }

        for token in cited_numbers(&sentence.text, locale) {
            if !entitled(&token, &allowed, &labels) {
                dropped.push(DroppedSentence {
                    sentence: sentence.clone(),
                    reason: DropReason::UncitedNumber(token),
                });
                continue 'sentence;
            }
        }

        covered.extend(sentence.fact_ids.iter().cloned());
        kept.push(sentence);
    }

    let uncovered = facts
        .iter()
        .map(|f| f.id.clone())
        .filter(|id| !covered.contains(id))
        .collect();

    NarrationCheck { kept, dropped, covered, uncovered }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrate::{en::every_fact_kind_fixture, narrator_for};

    fn insight_of(fact: FactKind) -> Insight {
        Insight::new(fact, 1.0)
    }

    /// THE ORACLE. The deterministic narrator is, by definition, a narrator that
    /// only prints numbers its fact contains — so every sentence it writes must
    /// survive this check. If one does not, the checker is wrong about a
    /// rendering and would be deleting correct sentences in production.
    ///
    /// It runs both locales because the whole risk is formatting: sv-SE groups
    /// with a non-breaking space and decimals with a comma, and a checker that
    /// tokenised on en-US punctuation would pass here and fail every Swedish
    /// reader.
    #[test]
    fn the_deterministic_narrator_survives_its_own_check() {
        for locale in [Locale::En, Locale::Sv] {
            let narrator = narrator_for(locale);
            for fact in every_fact_kind_fixture() {
                let insight = insight_of(fact.clone());
                let sentence = TaggedSentence {
                    text: narrator.narrate(&fact),
                    fact_ids: vec![insight.id.clone()],
                };
                let checked = check_narration(vec![sentence.clone()], &[insight], locale);
                assert!(
                    checked.dropped.is_empty(),
                    "{:?} {}: the engine's own sentence was rejected — {:?}\n  sentence: {}",
                    locale,
                    fact.kind_key(),
                    checked.dropped.first().map(|d| &d.reason),
                    sentence.text,
                );
            }
        }
    }

    #[test]
    fn a_sentence_citing_a_number_its_fact_does_not_have_is_dropped() {
        let fact = every_fact_kind_fixture()
            .into_iter()
            .find(|f| f.kind_key() == "trend")
            .expect("the fixture covers trend");
        let insight = insight_of(fact);
        let sentence = TaggedSentence {
            // 8,675,309 is in no fact anywhere.
            text: "Revenue rose by 8,675,309 over the period.".into(),
            fact_ids: vec![insight.id.clone()],
        };
        let checked = check_narration(vec![sentence], &[insight], Locale::En);
        assert!(checked.kept.is_empty());
        assert!(matches!(
            checked.dropped[0].reason,
            DropReason::UncitedNumber(ref n) if n == "8,675,309"
        ));
    }

    #[test]
    fn a_sentence_may_not_borrow_a_number_from_a_fact_it_did_not_cite() {
        // The rule is per-sentence, not per-run. A narration that prints one
        // fact's figure in another fact's sentence has made a claim nobody
        // computed, and it is exactly the mistake a fluent model makes.
        let facts: Vec<Insight> = every_fact_kind_fixture()
            .into_iter()
            .filter(|f| matches!(f.kind_key(), "trend" | "correlation"))
            .map(insight_of)
            .collect();
        assert_eq!(facts.len(), 2, "the fixture must supply both");

        let narrator = narrator_for(Locale::En);
        let other_text = narrator.narrate(&facts[1].kind);
        let borrowed = cited_numbers(&other_text, Locale::En);
        assert!(!borrowed.is_empty(), "the other fact's sentence must print a number");

        let sentence = TaggedSentence {
            text: format!("Revenue moved by {}.", borrowed[0]),
            fact_ids: vec![facts[0].id.clone()],
        };
        let checked = check_narration(vec![sentence], &facts, Locale::En);
        // It is allowed ONLY if that spelling genuinely also occurs in the cited
        // fact; otherwise it must be dropped.
        let allowed_by_cited = allowed_renderings(&facts[0].kind, Locale::En);
        if allowed_by_cited.contains(&borrowed[0]) {
            assert_eq!(checked.kept.len(), 1);
        } else {
            assert!(checked.kept.is_empty(), "borrowed {} was not dropped", borrowed[0]);
        }
    }

    #[test]
    fn a_sentence_naming_a_fact_that_was_never_computed_is_dropped() {
        let insight = insight_of(every_fact_kind_fixture().remove(0));
        let sentence = TaggedSentence {
            text: "Something happened.".into(),
            fact_ids: vec!["trend:m/Invented:".into()],
        };
        let checked = check_narration(vec![sentence], &[insight], Locale::En);
        assert!(checked.kept.is_empty());
        assert!(matches!(checked.dropped[0].reason, DropReason::UnknownFact(_)));
    }

    #[test]
    fn a_sentence_citing_nothing_is_dropped_however_true_it_sounds() {
        let insight = insight_of(every_fact_kind_fixture().remove(0));
        let checked = check_narration(
            vec![TaggedSentence { text: "Revenue looks healthy.".into(), fact_ids: vec![] }],
            &[insight],
            Locale::En,
        );
        assert!(checked.kept.is_empty());
        assert_eq!(checked.dropped[0].reason, DropReason::NoFactCited);
    }

    #[test]
    fn a_sentence_with_no_numbers_at_all_is_kept_when_it_cites_a_fact() {
        // Narration is allowed to say a qualitative thing. The rule is about
        // numbers, and a sentence with none cites nothing it could invent.
        let insight = insight_of(every_fact_kind_fixture().remove(0));
        let checked = check_narration(
            vec![TaggedSentence {
                text: "The series trends upward across the period.".into(),
                fact_ids: vec![insight.id.clone()],
            }],
            &[insight],
            Locale::En,
        );
        assert_eq!(checked.kept.len(), 1);
    }

    #[test]
    fn coverage_reports_what_nobody_narrated() {
        let facts: Vec<Insight> = every_fact_kind_fixture().into_iter().take(3).map(insight_of).collect();
        let checked = check_narration(
            vec![TaggedSentence { text: "A remark.".into(), fact_ids: vec![facts[0].id.clone()] }],
            &facts,
            Locale::En,
        );
        assert_eq!(checked.covered.len(), 1);
        assert_eq!(checked.uncovered.len(), 2);
        assert!((checked.coverage() - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn the_tokeniser_reads_each_locale_in_its_own_spelling() {
        // en-US groups with a comma; sv-SE groups with U+00A0 and uses a decimal
        // comma. A tokeniser that assumed one would split the other's numbers in
        // half and reject every sentence containing a large figure.
        assert_eq!(cited_numbers("rose to 1,234.5 units", Locale::En), vec!["1,234.5"]);
        assert_eq!(cited_numbers("steg till 1\u{00A0}234,5 enheter", Locale::Sv), vec!["1\u{00A0}234,5"]);
        assert_eq!(cited_numbers("up +42.1% on the year", Locale::En), vec!["+42.1%"]);
        assert_eq!(cited_numbers("down -5.0% on the year", Locale::En), vec!["-5.0%"]);
        // A full stop that ends a sentence is not a decimal point.
        assert_eq!(cited_numbers("there were 12.", Locale::En), vec!["12"]);
        // Scientific form survives as one token.
        assert_eq!(cited_numbers("a value of 1.23E-5 here", Locale::En), vec!["1.23E-5"]);
    }

    #[test]
    fn a_falling_trend_prints_its_slope_without_a_minus_and_is_still_entitled_to_it() {
        // `derived()` allows `|v|` because the Trend template prints
        // `num(slope_per_step.abs())` — the direction is already in the words
        // ("falling"), and a minus there would read as a second negation.
        //
        // The shared all-kinds fixture happens to carry a POSITIVE slope, so it
        // cannot exercise this: with `v >= 0`, `|v| == v` and removing the
        // derivation entirely leaves the oracle green. A sabotage said so, which
        // is the only reason this test exists. It must use a NEGATIVE slope, and
        // a negative `pct_change`, or it guards nothing either.
        let fact = FactKind::Trend {
            subject: crate::types::Subject::measure("Revenue"),
            slope_per_step: -12.5,
            r2: 0.81,
            pct_change: -0.23,
            first: 500.0,
            last: 385.0,
            n: 10,
            direction: crate::types::Direction::Falling,
        };
        for locale in [Locale::En, Locale::Sv] {
            let insight = insight_of(fact.clone());
            let text = narrator_for(locale).narrate(&fact);
            assert!(
                text.contains(&num(12.5, &locale.number_settings())),
                "{locale:?}: the template must print the slope unsigned: {text}"
            );
            let checked = check_narration(
                vec![TaggedSentence { text: text.clone(), fact_ids: vec![insight.id.clone()] }],
                &[insight],
                locale,
            );
            assert!(
                checked.dropped.is_empty(),
                "{locale:?}: a falling trend's own sentence was rejected — {:?}\n  {text}",
                checked.dropped.first().map(|d| &d.reason),
            );
        }
    }

    #[test]
    fn a_number_inside_a_label_the_fact_carries_is_not_an_invention() {
        // A change point "at Mar 2024" prints 2024, which is not one of the
        // fact's NUMBERS but is certainly in the fact. Without this the checker
        // deletes the narrator for quoting a label back at it.
        let fact = FactKind::ChangePoint {
            subject: crate::types::Subject::measure("Revenue"),
            at_label: "Mar 2024".into(),
            at_index: 3,
            before_mean: 1.0,
            after_mean: 2.0,
            shift_sd: 4.0,
        };
        let insight = insight_of(fact);
        let checked = check_narration(
            vec![TaggedSentence {
                text: "The level shifted at Mar 2024.".into(),
                fact_ids: vec![insight.id.clone()],
            }],
            &[insight],
            Locale::En,
        );
        assert!(checked.kept.len() == 1, "dropped: {:?}", checked.dropped);
    }
}
