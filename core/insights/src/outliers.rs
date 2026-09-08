//! FILENAME: core/insights/src/outliers.rs
// PURPOSE: Points that sit outside the body of a series, and which fence found
// them.
// CONTEXT: Which method is used is decided by SAMPLE SIZE, not by taste. Below
// `OUTLIER_Z_MIN_N` a single extreme value drags the mean toward itself and
// inflates the standard deviation enough to hide inside its own 3-sigma band --
// the z-score method's failure mode is missing exactly the point it was asked
// to find. Quartiles do not move when the tail does, so small samples use
// fences and large ones use sigma.

use crate::stats;
use crate::thresholds::*;
use crate::timeseries::Series;
use crate::types::{FactKind, OutlierMethod, OutlierPoint};

/// One `Outliers` fact for the series, or `None` when nothing is outside.
pub fn outlier_fact(series: &Series) -> Option<FactKind> {
    let values = &series.values;
    let n = values.len();
    if n < OUTLIER_MIN_N {
        return None;
    }

    let moments = stats::Moments::of(values);
    let sd = moments.stdev_sample().unwrap_or(0.0);

    let (method, low, high) = if n >= OUTLIER_Z_MIN_N && sd > 0.0 {
        (
            OutlierMethod::ZScore,
            moments.mean - OUTLIER_Z * sd,
            moments.mean + OUTLIER_Z * sd,
        )
    } else {
        let fences = stats::iqr_fences(values, OUTLIER_IQR_K)?;
        (OutlierMethod::Iqr, fences.low, fences.high)
    };

    // Strictly outside. A constant column has collapsed fences where every
    // value sits exactly ON them, and `>=` would flag the entire column.
    let mut flagged: Vec<OutlierPoint> = Vec::new();
    for (i, &v) in values.iter().enumerate() {
        if v < low || v > high {
            flagged.push(OutlierPoint {
                index: i,
                label: series
                    .labels
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| (i + 1).to_string()),
                value: v,
                z: if sd > 0.0 { (v - moments.mean) / sd } else { 0.0 },
            });
        }
    }
    if flagged.is_empty() {
        return None;
    }
    let total = flagged.len();

    // Escalate the LABEL, not the fence: the reported points are still the ones
    // outside 1.5 x IQR, but when every one of them is also past the far-out
    // fence the narration should not call them mild.
    let method = if method == OutlierMethod::Iqr {
        match stats::iqr_fences(values, OUTLIER_IQR_K_EXTREME) {
            Some(far) if flagged.iter().all(|p| p.value < far.low || p.value > far.high) => {
                OutlierMethod::IqrExtreme
            }
            _ => method,
        }
    } else {
        method
    };

    // Furthest first, ties by position, so the same three points are named on
    // every run.
    flagged.sort_by(|a, b| {
        distance_outside(b.value, low, high)
            .partial_cmp(&distance_outside(a.value, low, high))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.index.cmp(&b.index))
    });
    flagged.truncate(OUTLIER_MAX_REPORTED);

    Some(FactKind::Outliers {
        subject: series.subject.clone(),
        method,
        low_fence: low,
        high_fence: high,
        points: flagged,
        total,
    })
}

fn distance_outside(v: f64, low: f64, high: f64) -> f64 {
    if v < low {
        low - v
    } else if v > high {
        v - high
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Subject;

    fn series(name: &str, values: Vec<f64>) -> Series {
        let labels: Vec<String> = (1..=values.len()).map(|i| format!("R{i}")).collect();
        Series::new(Subject::measure(name), &labels, &values)
    }

    /// Deterministic, small, zero-mean wobble. A fixed table rather than a
    /// pseudo-random generator: a test whose data changes with a seed is a test
    /// that fails on someone else's machine.
    fn wobble(i: usize) -> f64 {
        [0.0, 1.0, -1.0, 2.0, -2.0, 1.0, -1.0, 0.0][i % 8]
    }

    #[test]
    fn an_injected_outlier_is_flagged_and_nothing_else_is() {
        let mut values: Vec<f64> = (0..20).map(|i| 100.0 + wobble(i)).collect();
        values[7] = 400.0;
        let s = series("Spiky", values);

        let fact = outlier_fact(&s).expect("a 4x spike must be flagged");
        match fact {
            FactKind::Outliers {
                points,
                total,
                method,
                ..
            } => {
                assert_eq!(total, 1, "exactly one point is outside, got {points:?}");
                assert_eq!(points.len(), 1);
                assert_eq!(points[0].index, 7);
                assert_eq!(points[0].value, 400.0);
                assert_eq!(points[0].label, "R8");
                // 20 points is below OUTLIER_Z_MIN_N, so quartiles decide.
                assert!(matches!(
                    method,
                    OutlierMethod::Iqr | OutlierMethod::IqrExtreme
                ));
            }
            other => panic!("expected outliers, got {other:?}"),
        }
    }

    #[test]
    fn a_constant_column_produces_no_outlier_fact() {
        // Collapsed fences: q1 == q3, so every value sits exactly on both. A
        // `>=` comparison would flag all twenty.
        let s = series("Flat", vec![42.0; 20]);
        assert!(outlier_fact(&s).is_none());
    }

    #[test]
    fn a_clean_column_produces_no_outlier_fact() {
        let s = series("Clean", (0..20).map(|i| 100.0 + wobble(i)).collect());
        assert!(outlier_fact(&s).is_none());
    }

    #[test]
    fn a_short_column_is_not_scanned_at_all() {
        let s = series("Short", vec![1.0, 2.0, 3.0, 900.0]);
        assert!(
            outlier_fact(&s).is_none(),
            "quartiles of four points find an outlier in almost anything"
        );
    }

    #[test]
    fn a_large_sample_switches_to_the_sigma_method() {
        let mut values: Vec<f64> = (0..60).map(|i| 100.0 + wobble(i)).collect();
        values[30] = 500.0;
        let s = series("Big", values);
        match outlier_fact(&s).expect("must flag the spike") {
            FactKind::Outliers { method, points, .. } => {
                assert_eq!(method, OutlierMethod::ZScore);
                assert_eq!(points[0].index, 30);
            }
            other => panic!("expected outliers, got {other:?}"),
        }
    }

    #[test]
    fn only_the_furthest_points_are_named_but_the_total_is_not_hidden() {
        let mut values: Vec<f64> = (0..24).map(|i| 100.0 + wobble(i)).collect();
        for (rank, idx) in [3usize, 9, 15, 21].iter().enumerate() {
            values[*idx] = 500.0 + 100.0 * rank as f64;
        }
        let s = series("Many", values);
        match outlier_fact(&s).expect("must flag the spikes") {
            FactKind::Outliers { points, total, .. } => {
                assert_eq!(total, 4);
                assert_eq!(points.len(), OUTLIER_MAX_REPORTED);
                assert_eq!(points[0].value, 800.0, "furthest must be named first");
            }
            other => panic!("expected outliers, got {other:?}"),
        }
    }
}
