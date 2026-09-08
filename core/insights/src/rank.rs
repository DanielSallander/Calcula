//! FILENAME: core/insights/src/rank.rs
// PURPOSE: Turn a pile of facts into the dozen worth saying, in an order that
// does not change between runs.
// CONTEXT: Determinism here is not a nicety. The narration is cached, diffed
// and shown next to a signed `.calp` report; if the same data produced the same
// twelve findings in a different ORDER on two machines, every one of those
// downstream comparisons would report a spurious change. So the sort is total
// (score DESC, then id ASC -- ids are unique after the dedupe, so no pair is
// ever left to the sort's own tie-breaking) and nothing consults a hash map.

use std::collections::hash_map::Entry;

use rustc_hash::FxHashMap;

use crate::thresholds::*;
use crate::types::{FactKind, Insight};

/// Strength of a fact within its own kind, on 0..=1. Combined with the kind's
/// base weight so a weak instance of a strong kind can lose to a strong
/// instance of a weaker one.
fn strength(kind: &FactKind) -> f64 {
    let clamp = |v: f64| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
    match kind {
        // Orientation is orientation; there is no weak version of it.
        FactKind::Shape { .. } => 1.0,
        FactKind::ColumnSummary { n, .. } => clamp(*n as f64 / 100.0),
        FactKind::TextSummary { distinct, .. } => clamp(1.0 - *distinct as f64 / 100.0),
        FactKind::BooleanShare { true_share, .. } => clamp((true_share - 0.5).abs() * 2.0),
        FactKind::Trend { r2, .. } => clamp(*r2),
        FactKind::Change { pct, .. } => clamp(pct.abs()),
        FactKind::Extremes { best, worst, .. } => {
            let span = (best - worst).abs();
            let scale = best.abs().max(worst.abs());
            if scale > 0.0 {
                clamp(span / scale)
            } else {
                0.0
            }
        }
        FactKind::SmoothedPeak { peak, trough, .. } => {
            let scale = peak.abs().max(trough.abs());
            if scale > 0.0 {
                clamp((peak - trough).abs() / scale)
            } else {
                0.0
            }
        }
        FactKind::Seasonality { acf, .. } => clamp(*acf),
        FactKind::ChangePoint { shift_sd, .. } => clamp(shift_sd / 6.0),
        // More points outside the fence is a worse problem, and the furthest
        // point's z carries how far outside.
        FactKind::Outliers { points, .. } => points
            .iter()
            .map(|p| clamp(p.z.abs() / 10.0))
            .fold(0.0f64, f64::max),
        FactKind::Correlation { r, .. } => clamp(r.abs()),
        FactKind::Dominance { top_share, .. } => clamp(*top_share),
        FactKind::Pareto { top_k, categories, .. } => {
            if *categories == 0 {
                0.0
            } else {
                clamp(1.0 - *top_k as f64 / *categories as f64)
            }
        }
        FactKind::Duplicates { rows, .. } => clamp(*rows as f64 / 20.0),
        FactKind::BlankRows { rows } => clamp(*rows as f64 / 20.0),
        // There is no weak version of a broken cell. One `#REF!` invalidates
        // every number derived from the column just as thoroughly as fifty do,
        // and scaling by the count let a perfect-fit trend outrank the error
        // that made the fit meaningless. The count belongs in the sentence.
        FactKind::Errors { .. } => 1.0,
        FactKind::MixedTypes {
            number_share,
            text_share,
            ..
        } => clamp(number_share.min(*text_share) * 2.0),
        FactKind::Crossover { .. } => 1.0,
        FactKind::Leader { share, .. } => clamp(*share),
    }
}

fn base_weight(kind: &FactKind) -> f64 {
    match kind {
        FactKind::Shape { .. } => SCORE_SHAPE,
        FactKind::ColumnSummary { .. } => SCORE_COLUMN_SUMMARY,
        FactKind::TextSummary { .. } => SCORE_TEXT_SUMMARY,
        FactKind::BooleanShare { .. } => SCORE_BOOLEAN_SHARE,
        FactKind::Trend { .. } => SCORE_TREND,
        FactKind::Change { .. } => SCORE_CHANGE,
        FactKind::Extremes { .. } => SCORE_EXTREMES,
        FactKind::SmoothedPeak { .. } => SCORE_SMOOTHED_PEAK,
        FactKind::Seasonality { .. } => SCORE_SEASONALITY,
        FactKind::ChangePoint { .. } => SCORE_CHANGE_POINT,
        FactKind::Outliers { .. } => SCORE_OUTLIERS,
        FactKind::Correlation { .. } => SCORE_CORRELATION,
        FactKind::Dominance { .. } => SCORE_DOMINANCE,
        FactKind::Pareto { .. } => SCORE_PARETO,
        FactKind::Duplicates { .. } => SCORE_DUPLICATES,
        FactKind::BlankRows { .. } => SCORE_BLANK_ROWS,
        FactKind::Errors { .. } => SCORE_ERRORS,
        FactKind::MixedTypes { .. } => SCORE_MIXED_TYPES,
        FactKind::Crossover { .. } => SCORE_CROSSOVER,
        FactKind::Leader { .. } => SCORE_LEADER,
    }
}

/// `base * (0.5 + 0.5 * strength)`: half the score is the kind, half is how
/// strong this instance of it is. A kind can therefore never be outranked by a
/// kind less than half its weight, however strong the weaker instance is.
pub fn score(kind: &FactKind) -> f64 {
    base_weight(kind) * (0.5 + 0.5 * strength(kind))
}

/// What survived, and how many did not.
#[derive(Debug, Clone, PartialEq)]
pub struct Ranked {
    pub kept: Vec<Insight>,
    pub dropped: usize,
}

pub fn rank(insights: Vec<Insight>) -> Ranked {
    let considered = insights.len();

    // Dedupe on id, keeping the higher-scoring copy. Two producers can reach
    // the same finding by different routes (a column analysed as a series and
    // as a plain column), and printing it twice is the most obviously wrong
    // thing this crate could do.
    let mut best: FxHashMap<String, Insight> = FxHashMap::default();
    let mut order: Vec<String> = Vec::new();
    for insight in insights {
        match best.entry(insight.id.clone()) {
            Entry::Occupied(mut slot) => {
                if slot.get().score < insight.score {
                    slot.insert(insight);
                }
            }
            Entry::Vacant(slot) => {
                order.push(insight.id.clone());
                slot.insert(insight);
            }
        }
    }
    // `order` is insertion order, not map order: nothing downstream may depend
    // on how FxHashMap happens to iterate.
    let mut unique: Vec<Insight> = order
        .into_iter()
        .filter_map(|id| best.remove(&id))
        .collect();

    unique.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id))
    });

    let mut per_kind: FxHashMap<&'static str, usize> = FxHashMap::default();
    let mut kept: Vec<Insight> = Vec::new();
    for insight in unique {
        if kept.len() >= MAX_INSIGHTS {
            break;
        }
        let key = insight.kind.kind_key();
        let count = per_kind.entry(key).or_insert(0);
        if *count >= MAX_PER_KIND {
            continue;
        }
        *count += 1;
        kept.push(insight);
    }

    let dropped = considered.saturating_sub(kept.len());
    Ranked { kept, dropped }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Direction, Subject};

    fn trend(name: &str, r2: f64) -> Insight {
        let kind = FactKind::Trend {
            subject: Subject::measure(name),
            slope_per_step: 1.0,
            r2,
            pct_change: 0.5,
            first: 1.0,
            last: 10.0,
            n: 10,
            direction: Direction::Rising,
        };
        let s = score(&kind);
        Insight::new(kind, s)
    }

    fn summary(name: &str) -> Insight {
        let kind = FactKind::ColumnSummary {
            subject: Subject::measure(name),
            n: 10,
            min: 1.0,
            max: 2.0,
            mean: 1.5,
            median: 1.5,
            stdev: 0.5,
        };
        let s = score(&kind);
        Insight::new(kind, s)
    }

    #[test]
    fn no_kind_may_take_more_than_its_share_of_the_budget() {
        let mut all: Vec<Insight> = (0..8).map(|i| trend(&format!("T{i}"), 0.9)).collect();
        all.extend((0..8).map(|i| summary(&format!("S{i}"))));
        let ranked = rank(all);
        let trends = ranked
            .kept
            .iter()
            .filter(|i| i.kind.kind_key() == "trend")
            .count();
        assert_eq!(trends, MAX_PER_KIND);
        assert_eq!(ranked.dropped, 16 - ranked.kept.len());
    }

    #[test]
    fn the_bundle_is_capped_at_the_budget() {
        // Five kinds x three-per-kind is fifteen, which is over the total cap,
        // so this proves the TOTAL cap bites and not only the per-kind one.
        // Every fact carries a distinct SUBJECT: a kind whose id ignores its
        // subject (`Duplicates`, `BlankRows`) collapses to one row under the
        // dedupe and would make the test pass for the wrong reason.
        let mut all: Vec<Insight> = Vec::new();
        for i in 0..10 {
            all.push(trend(&format!("T{i}"), 0.9));
            all.push(summary(&format!("S{i}")));
            for (kind, s) in [
                (
                    FactKind::Seasonality {
                        subject: Subject::measure(&format!("Z{i}")),
                        lag: 12,
                        acf: 0.8,
                    },
                    0.7,
                ),
                (
                    FactKind::Extremes {
                        subject: Subject::measure(&format!("E{i}")),
                        best_label: "Mar".into(),
                        best: 10.0,
                        worst_label: "Jan".into(),
                        worst: 1.0,
                    },
                    0.4,
                ),
                (
                    FactKind::MixedTypes {
                        subject: Subject::measure(&format!("M{i}")),
                        number_share: 0.5,
                        text_share: 0.5,
                    },
                    0.5,
                ),
            ] {
                all.push(Insight::new(kind, s));
            }
        }
        let ranked = rank(all);
        assert_eq!(ranked.kept.len(), MAX_INSIGHTS);
        assert!(ranked.dropped > 0);
        let distinct_kinds: std::collections::BTreeSet<&str> =
            ranked.kept.iter().map(|i| i.kind.kind_key()).collect();
        assert!(
            distinct_kinds.len() >= 4,
            "the cap must keep the output diverse, saw {distinct_kinds:?}"
        );
    }

    #[test]
    fn the_same_finding_reached_twice_is_kept_once_at_its_higher_score() {
        let a = trend("Revenue", 0.9);
        let mut b = trend("Revenue", 0.9);
        b.score += 1.0;
        assert_eq!(a.id, b.id);
        let ranked = rank(vec![a, b]);
        assert_eq!(ranked.kept.len(), 1);
        assert_eq!(ranked.dropped, 1);
        assert!(ranked.kept[0].score > 1.0);
    }

    #[test]
    fn ties_are_broken_by_id_so_the_order_never_moves() {
        let inputs: Vec<Insight> = ["Delta", "Alpha", "Charlie", "Bravo"]
            .iter()
            .map(|n| trend(n, 0.9))
            .collect();
        let first = rank(inputs.clone());
        // Feed the same set in the opposite order: the output must be identical.
        let mut reversed = inputs;
        reversed.reverse();
        let second = rank(reversed);
        let ids_first: Vec<&str> = first.kept.iter().map(|i| i.id.as_str()).collect();
        let ids_second: Vec<&str> = second.kept.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids_first, ids_second);
        assert!(ids_first.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn a_strong_weak_kind_never_outranks_a_weak_strong_kind_by_more_than_double() {
        // The 0.5 floor in `score` is what guarantees this; without it a
        // perfect-strength ColumnSummary could outscore a marginal Trend.
        let weak_trend = score(&FactKind::Trend {
            subject: Subject::measure("T"),
            slope_per_step: 1.0,
            r2: TREND_MIN_R2,
            pct_change: 0.1,
            first: 1.0,
            last: 2.0,
            n: 6,
            direction: Direction::Rising,
        });
        let strong_summary = SCORE_COLUMN_SUMMARY * 1.0;
        assert!(weak_trend > strong_summary, "{weak_trend} vs {strong_summary}");
    }
}
