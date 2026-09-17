//! FILENAME: core/insights/src/relations.rs
// PURPOSE: Facts about how two columns move together, and about how a total is
// split across the values of a category.
// CONTEXT: Nothing in this file asserts a direction of influence, and the
// English template for `Correlation` is required to say so out loud. Two
// columns moving together is the single most over-read output of any automatic
// analysis, and the crate's whole claim to being trustworthy rests on not
// making that leap in a sentence the user will quote to someone else.

use rustc_hash::FxHashMap;

use crate::stats;
use crate::thresholds::*;
use crate::types::{FactKind, Subject};

/// One numeric column, ROW-ALIGNED: `f64::NAN` marks a row this column has no
/// value for. Correlation is pairwise-complete over these, so a hole never
/// slides one column against the other.
#[derive(Debug, Clone)]
pub struct AlignedColumn {
    pub subject: Subject,
    pub values: Vec<f64>,
}

/// The strongest few pairs, each reported ONCE (i < j). Pairs are ranked by
/// |r| and tie-broken by subject key so the same three pairs come out of the
/// same data on every run.
pub fn correlation_facts(columns: &[AlignedColumn]) -> Vec<FactKind> {
    let mut candidates: Vec<(f64, String, FactKind)> = Vec::new();
    for i in 0..columns.len() {
        for j in (i + 1)..columns.len() {
            let a = &columns[i];
            let b = &columns[j];
            let n = stats::paired_n(&a.values, &b.values);
            if n < CORRELATION_MIN_N {
                continue;
            }
            let Some(r) = stats::pearson(&a.values, &b.values) else {
                continue;
            };
            if r.abs() < CORRELATION_MIN_ABS_R {
                continue;
            }
            let key = format!("{}|{}", a.subject.key(), b.subject.key());
            candidates.push((
                r.abs(),
                key,
                FactKind::Correlation {
                    a: a.subject.clone(),
                    b: b.subject.clone(),
                    r,
                    n,
                },
            ));
        }
    }
    candidates.sort_by(|x, y| {
        y.0.partial_cmp(&x.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(x.1.cmp(&y.1))
    });
    candidates.truncate(CORRELATION_MAX_PAIRS);
    candidates.into_iter().map(|(_, _, fact)| fact).collect()
}

/// Category totals, largest first, ties broken by name so the ordering does not
/// depend on the hasher. This is the ONE place a map is used in this crate, and
/// its output is sorted before anything else sees it.
pub fn category_totals(rows: &[(String, f64)]) -> Vec<(String, f64)> {
    let mut sums: FxHashMap<String, f64> = FxHashMap::default();
    for (name, value) in rows {
        if !value.is_finite() {
            continue;
        }
        *sums.entry(name.clone()).or_insert(0.0) += *value;
    }
    let mut out: Vec<(String, f64)> = sums.into_iter().collect();
    out.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    out
}

/// A share is only meaningful when the parts add up. A breakdown containing a
/// negative total (a refund category, a contra account) has no denominator that
/// makes "40% of the total" true, so composition facts refuse it outright
/// rather than printing a share above 100% or below zero.
fn shareable_total(totals: &[(String, f64)]) -> Option<f64> {
    if totals.is_empty() || totals.iter().any(|(_, v)| *v < 0.0) {
        return None;
    }
    let total: f64 = totals.iter().map(|(_, v)| *v).sum();
    if total > 0.0 {
        Some(total)
    } else {
        None
    }
}

/// The supplied row a category name sits in, when it sits in exactly one.
///
/// `row_positions[i]` is the supplied index of `rows[i]`; an empty slice means
/// the caller does not know, and the answer is `None` rather than a guess.
fn single_row_of(name: &str, rows: &[(String, f64)], row_positions: &[usize]) -> Option<usize> {
    if row_positions.len() != rows.len() {
        return None;
    }
    let mut found: Option<usize> = None;
    for (i, (n, _)) in rows.iter().enumerate() {
        if n != name {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(row_positions[i]);
    }
    found
}

/// `rows` are (category, value) pairs and `row_positions` says which supplied
/// row each pair came from (same length, or empty when unknown), so the fact
/// can point at the top category's row where there is exactly one.
pub fn dominance_fact(
    category: &str,
    value: &str,
    rows: &[(String, f64)],
    row_positions: &[usize],
) -> Option<FactKind> {
    let totals = category_totals(rows);
    if totals.len() < 2 || totals.len() > DOMINANCE_MAX_CATEGORIES {
        return None;
    }
    let grand = shareable_total(&totals)?;
    let (top_name, top_value) = totals[0].clone();
    let top_share = top_value / grand;
    if top_share < DOMINANCE_MIN_SHARE {
        return None;
    }
    let top_index = single_row_of(&top_name, rows, row_positions);
    Some(FactKind::Dominance {
        category: category.to_string(),
        value: value.to_string(),
        top_category: top_name,
        top_index,
        top_share,
        categories: totals.len(),
    })
}

pub fn pareto_fact(category: &str, value: &str, rows: &[(String, f64)]) -> Option<FactKind> {
    let totals = category_totals(rows);
    if totals.len() < PARETO_MIN_CATEGORIES {
        return None;
    }
    let grand = shareable_total(&totals)?;
    let mut running = 0.0;
    let mut top_k = 0usize;
    for (_, v) in &totals {
        running += *v;
        top_k += 1;
        if running / grand >= PARETO_TARGET {
            break;
        }
    }
    let fraction = top_k as f64 / totals.len() as f64;
    if fraction > PARETO_MAX_CATEGORY_FRACTION {
        // A flat distribution: it takes most of the categories to reach 80%,
        // which is the OPPOSITE of a Pareto effect and must not be reported as
        // one.
        return None;
    }
    Some(FactKind::Pareto {
        category: category.to_string(),
        value: value.to_string(),
        top_k,
        categories: totals.len(),
        share: running / grand,
    })
}

/// The largest of several whole series, by total. Distinct from `Dominance`,
/// which splits ONE measure across the values of a category column; this one
/// compares different measures with each other.
pub fn leader_fact(totals: &[(Subject, f64)]) -> Option<FactKind> {
    if totals.len() < LEADER_MIN_SERIES {
        return None;
    }
    let as_named: Vec<(String, f64)> = totals
        .iter()
        .map(|(s, v)| (s.key(), *v))
        .collect();
    let grand = shareable_total(&as_named)?;
    let mut best: Option<(usize, f64)> = None;
    for (i, (_, v)) in totals.iter().enumerate() {
        let better = match best {
            None => true,
            Some((_, b)) => *v > b,
        };
        if better {
            best = Some((i, *v));
        }
    }
    let (idx, value) = best?;
    let share = value / grand;
    if share < LEADER_MIN_SHARE {
        return None;
    }
    Some(FactKind::Leader {
        subject: totals[idx].0.clone(),
        share,
        others: totals.len() - 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, values: Vec<f64>) -> AlignedColumn {
        AlignedColumn {
            subject: Subject::measure(name),
            values,
        }
    }

    #[test]
    fn two_correlated_columns_are_reported_once() {
        let a = col("Spend", (0..12).map(|i| i as f64).collect());
        let b = col("Sales", (0..12).map(|i| 3.0 + 2.0 * i as f64).collect());
        let facts = correlation_facts(&[a, b]);
        assert_eq!(facts.len(), 1, "an unordered pair must not be reported twice");
        match &facts[0] {
            FactKind::Correlation { r, n, .. } => {
                assert!((r - 1.0).abs() < 1e-9);
                assert_eq!(*n, 12);
            }
            other => panic!("expected a correlation, got {other:?}"),
        }
    }

    #[test]
    fn a_constant_column_correlates_with_nothing() {
        let flat = col("Flat", vec![5.0; 12]);
        let rising = col("Rising", (0..12).map(|i| i as f64).collect());
        let rising2 = col("Rising2", (0..12).map(|i| 10.0 + 4.0 * i as f64).collect());
        let facts = correlation_facts(&[flat, rising, rising2]);
        // Positive control in the same call: the two that DO vary must pair up.
        assert_eq!(facts.len(), 1);
        match &facts[0] {
            FactKind::Correlation { a, b, .. } => {
                assert_eq!(a.label(), "Rising");
                assert_eq!(b.label(), "Rising2");
            }
            other => panic!("expected a correlation, got {other:?}"),
        }
    }

    #[test]
    fn a_short_pair_is_refused_however_perfect_the_fit() {
        let a = col("A", vec![1.0, 2.0, 3.0, 4.0]);
        let b = col("B", vec![2.0, 4.0, 6.0, 8.0]);
        assert!(correlation_facts(&[a, b]).is_empty());
    }

    #[test]
    fn only_the_strongest_pairs_survive_the_cap() {
        let columns: Vec<AlignedColumn> = (0..6)
            .map(|k| {
                col(
                    &format!("C{k}"),
                    (0..12).map(|i| (i as f64) * (k as f64 + 1.0)).collect(),
                )
            })
            .collect();
        let facts = correlation_facts(&columns);
        assert_eq!(facts.len(), CORRELATION_MAX_PAIRS);
    }

    #[test]
    fn category_totals_are_sorted_by_size_then_name() {
        let rows = vec![
            ("North".to_string(), 10.0),
            ("South".to_string(), 30.0),
            ("East".to_string(), 10.0),
            ("North".to_string(), 5.0),
        ];
        let totals = category_totals(&rows);
        assert_eq!(
            totals,
            vec![
                ("South".to_string(), 30.0),
                ("North".to_string(), 15.0),
                ("East".to_string(), 10.0),
            ]
        );
    }

    #[test]
    fn a_dominant_category_is_reported_and_an_even_split_is_not() {
        let lopsided = vec![
            ("A".to_string(), 70.0),
            ("B".to_string(), 15.0),
            ("C".to_string(), 15.0),
        ];
        match dominance_fact("Region", "Sales", &lopsided, &[0, 1, 2]).expect("70% is dominant") {
            FactKind::Dominance {
                top_category,
                top_index,
                top_share,
                categories,
                ..
            } => {
                assert_eq!(top_category, "A");
                assert_eq!(top_index, Some(0));
                assert!((top_share - 0.7).abs() < 1e-9);
                assert_eq!(categories, 3);
            }
            other => panic!("expected dominance, got {other:?}"),
        }

        let even = vec![
            ("A".to_string(), 25.0),
            ("B".to_string(), 25.0),
            ("C".to_string(), 25.0),
            ("D".to_string(), 25.0),
        ];
        assert!(dominance_fact("Region", "Sales", &even, &[0, 1, 2, 3]).is_none());
    }

    #[test]
    fn the_top_category_is_indexed_only_when_it_sits_in_exactly_one_row() {
        // "A" occurs twice (summed to 70 of 100): no single row to point at.
        let split = vec![
            ("B".to_string(), 15.0),
            ("A".to_string(), 40.0),
            ("C".to_string(), 15.0),
            ("A".to_string(), 30.0),
        ];
        match dominance_fact("Region", "Sales", &split, &[0, 1, 2, 3]).expect("70% is dominant") {
            FactKind::Dominance { top_category, top_index, .. } => {
                assert_eq!(top_category, "A");
                assert_eq!(top_index, None, "two rows were summed; neither is THE row");
            }
            other => panic!("expected dominance, got {other:?}"),
        }

        // Supplied positions are honoured, not the pair's own index: the rows
        // handed over were rows 3, 7 and 9 of something larger.
        let sparse = vec![
            ("B".to_string(), 15.0),
            ("A".to_string(), 70.0),
            ("C".to_string(), 15.0),
        ];
        match dominance_fact("Region", "Sales", &sparse, &[3, 7, 9]).expect("70% is dominant") {
            FactKind::Dominance { top_index, .. } => assert_eq!(top_index, Some(7)),
            other => panic!("expected dominance, got {other:?}"),
        }

        // A caller that does not know the positions gets no index, not a guess.
        match dominance_fact("Region", "Sales", &sparse, &[]).expect("70% is dominant") {
            FactKind::Dominance { top_index, .. } => assert_eq!(top_index, None),
            other => panic!("expected dominance, got {other:?}"),
        }
    }

    #[test]
    fn a_breakdown_containing_a_negative_total_reports_no_share() {
        let with_refund = vec![
            ("A".to_string(), 100.0),
            ("Refunds".to_string(), -40.0),
            ("B".to_string(), 10.0),
        ];
        assert!(
            dominance_fact("Region", "Sales", &with_refund, &[0, 1, 2]).is_none(),
            "a share above 100% is worse than no share at all"
        );
    }

    #[test]
    fn a_pareto_effect_is_reported_and_a_flat_distribution_is_not() {
        let mut rows = vec![("Big".to_string(), 800.0)];
        for i in 0..9 {
            rows.push((format!("Small{i}"), 22.0));
        }
        match pareto_fact("Product", "Revenue", &rows).expect("one product carries 80%") {
            FactKind::Pareto {
                top_k,
                categories,
                share,
                ..
            } => {
                assert_eq!(top_k, 1);
                assert_eq!(categories, 10);
                assert!(share >= PARETO_TARGET);
            }
            other => panic!("expected pareto, got {other:?}"),
        }

        let flat: Vec<(String, f64)> = (0..10).map(|i| (format!("P{i}"), 100.0)).collect();
        assert!(pareto_fact("Product", "Revenue", &flat).is_none());
    }

    #[test]
    fn a_leader_needs_a_field_and_a_share() {
        let totals = vec![
            (Subject::measure("A"), 100.0),
            (Subject::measure("B"), 40.0),
            (Subject::measure("C"), 40.0),
        ];
        match leader_fact(&totals).expect("100 of 180 leads") {
            FactKind::Leader { subject, share, others } => {
                assert_eq!(subject.label(), "A");
                assert!((share - 100.0 / 180.0).abs() < 1e-9);
                assert_eq!(others, 2);
            }
            other => panic!("expected a leader, got {other:?}"),
        }

        let two = vec![(Subject::measure("A"), 100.0), (Subject::measure("B"), 1.0)];
        assert!(leader_fact(&two).is_none(), "two series is not a field");
    }
}
