//! FILENAME: core/insights/src/timeseries.rs
// PURPOSE: Facts that need the ORDER of the rows: trend, first-to-last change,
// extremes, smoothed peaks, seasonality, level shifts and crossings.
// CONTEXT: Every function here refuses more often than it answers. The
// thresholds in `thresholds.rs` are the refusals, and each one exists because
// the un-thresholded version of the same rule produces a confident sentence
// about noise -- a five-point "trend", a "cycle" that is really a ramp, a
// "level shift" that is one outlier.

use crate::stats;
use crate::thresholds::*;
use crate::types::{Direction, FactKind, Subject};

/// An ordered numeric series with a label per point. `Series::new` drops the
/// rows whose value is not finite, carrying the LABELS along with them so a
/// gap can never shift a label onto the wrong value.
#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    pub subject: Subject,
    pub labels: Vec<String>,
    pub values: Vec<f64>,
}

impl Series {
    pub fn new(subject: Subject, labels: &[String], values: &[f64]) -> Series {
        let mut kept_labels = Vec::new();
        let mut kept_values = Vec::new();
        for (i, v) in values.iter().enumerate() {
            if !v.is_finite() {
                continue;
            }
            kept_labels.push(
                labels
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| (i + 1).to_string()),
            );
            kept_values.push(*v);
        }
        Series {
            subject,
            labels: kept_labels,
            values: kept_values,
        }
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    fn label(&self, i: usize) -> String {
        self.labels
            .get(i)
            .cloned()
            .unwrap_or_else(|| (i + 1).to_string())
    }
}

/// Percentage change from `first` to `last`, measured against `|first|`.
///
/// `None` when the starting value is zero: "up 100%" from a base of nothing is
/// arithmetic nonsense and the honest report is the absolute numbers, which
/// `Change` already carries.
fn pct_change(first: f64, last: f64) -> Option<f64> {
    if first == 0.0 {
        None
    } else {
        Some((last - first) / first.abs())
    }
}

pub fn trend_fact(series: &Series) -> Option<FactKind> {
    let n = series.len();
    if n < MIN_POINTS_FOR_TREND {
        return None;
    }
    // `None` here is a constant column: no slope, and no fraction of variance
    // to account for.
    let fit = stats::ols_over_index(&series.values)?;
    if fit.r2 < TREND_MIN_R2 {
        return None;
    }
    let scale = stats::mean_abs(&series.values)?;
    if scale <= 0.0 {
        return None;
    }
    let total_change = fit.slope * (n - 1) as f64;
    if (total_change / scale).abs() < TREND_MIN_TOTAL_CHANGE_SHARE {
        return None;
    }
    let first = series.values[0];
    let last = series.values[n - 1];
    let direction = if fit.slope > 0.0 {
        Direction::Rising
    } else if fit.slope < 0.0 {
        Direction::Falling
    } else {
        Direction::Flat
    };
    Some(FactKind::Trend {
        subject: series.subject.clone(),
        slope_per_step: fit.slope,
        r2: fit.r2,
        // A series that starts at zero still has a defensible relative
        // movement: the fitted total change against the typical level.
        pct_change: pct_change(first, last).unwrap_or(total_change / scale),
        first,
        last,
        n,
        direction,
    })
}

pub fn change_fact(series: &Series) -> Option<FactKind> {
    let n = series.len();
    if n < CHANGE_MIN_POINTS {
        return None;
    }
    let first = series.values[0];
    let last = series.values[n - 1];
    let pct = pct_change(first, last)?;
    if pct.abs() < PCT_CHANGE_MIN_ABS {
        return None;
    }
    Some(FactKind::Change {
        subject: series.subject.clone(),
        first_label: series.label(0),
        last_label: series.label(n - 1),
        first,
        last,
        pct,
    })
}

/// Index of the first maximum and the first minimum. First rather than last so
/// two runs over identical data name the same month.
fn arg_extremes(values: &[f64]) -> Option<(usize, usize)> {
    if values.is_empty() {
        return None;
    }
    let mut hi = 0usize;
    let mut lo = 0usize;
    for (i, v) in values.iter().enumerate() {
        if *v > values[hi] {
            hi = i;
        }
        if *v < values[lo] {
            lo = i;
        }
    }
    Some((hi, lo))
}

pub fn extremes_fact(series: &Series) -> Option<FactKind> {
    if series.len() < EXTREMES_MIN_POINTS {
        return None;
    }
    let (hi, lo) = arg_extremes(&series.values)?;
    if series.values[hi] == series.values[lo] {
        // Flat: naming a "best" and a "worst" month that hold the same number
        // invents a ranking the data does not contain.
        return None;
    }
    Some(FactKind::Extremes {
        subject: series.subject.clone(),
        best_label: series.label(hi),
        best: series.values[hi],
        worst_label: series.label(lo),
        worst: series.values[lo],
    })
}

pub fn smoothed_peak_fact(series: &Series) -> Option<FactKind> {
    if series.len() < SMOOTHED_PEAK_MIN_POINTS {
        return None;
    }
    let smoothed = stats::moving_average(&series.values, SMOOTHING_WINDOW);
    let defined: Vec<(usize, f64)> = smoothed
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v.map(|v| (i, v)))
        .collect();
    if defined.len() < SMOOTHING_WINDOW {
        return None;
    }
    let mut hi = defined[0];
    let mut lo = defined[0];
    for &(i, v) in &defined {
        if v > hi.1 {
            hi = (i, v);
        }
        if v < lo.1 {
            lo = (i, v);
        }
    }
    if hi.1 == lo.1 {
        return None;
    }
    Some(FactKind::SmoothedPeak {
        subject: series.subject.clone(),
        window: SMOOTHING_WINDOW,
        peak_label: series.label(hi.0),
        peak: hi.1,
        trough_label: series.label(lo.0),
        trough: lo.1,
    })
}

/// Every candidate lag the series is long enough to test, with its detrended
/// autocorrelation. Exposed so a caller (and the tests) can see the lags that
/// were REJECTED, not only the one that won.
pub fn seasonality_scan(series: &Series) -> Vec<(usize, f64)> {
    let mut out = Vec::new();
    for &lag in SEASONALITY_LAGS.iter() {
        if series.len() < lag * SEASONALITY_MIN_CYCLES {
            continue;
        }
        if let Some(acf) = stats::autocorrelation_detrended(&series.values, lag) {
            out.push((lag, acf));
        }
    }
    out
}

pub fn seasonality_fact(series: &Series) -> Option<FactKind> {
    let scan = seasonality_scan(series);
    let mut best: Option<(usize, f64)> = None;
    for (lag, acf) in scan {
        if acf < SEASONALITY_MIN_ACF {
            continue;
        }
        // Strictly greater keeps the SHORTEST qualifying lag on a tie, which is
        // the one a reader recognises: a 12-point cycle also shows at lag 24.
        let better = match best {
            None => true,
            Some((_, b)) => acf > b,
        };
        if better {
            best = Some((lag, acf));
        }
    }
    let (lag, acf) = best?;
    Some(FactKind::Seasonality {
        subject: series.subject.clone(),
        lag,
        acf,
    })
}

/// Binary segmentation, depth-limited. Splitting recursively without a limit
/// finds a "level shift" in every noisy stretch; two is already the whole story
/// a bullet list can carry (`CHANGEPOINT_MAX`).
pub fn change_point_facts(series: &Series) -> Vec<FactKind> {
    let mut found: Vec<(usize, stats::ChangePointFit)> = Vec::new();
    collect_change_points(&series.values, 0, 3, &mut found);

    // Rank by strength, keep the budget, then present in reading order. Sorting
    // by index alone would keep an early weak shift over a later obvious one.
    found.sort_by(|a, b| {
        b.1.shift_sd
            .partial_cmp(&a.1.shift_sd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    found.truncate(CHANGEPOINT_MAX);
    found.sort_by_key(|(offset, fit)| offset + fit.index);

    found
        .into_iter()
        .map(|(offset, fit)| {
            let at_index = offset + fit.index;
            FactKind::ChangePoint {
                subject: series.subject.clone(),
                at_label: series.label(at_index),
                at_index,
                before_mean: fit.before_mean,
                after_mean: fit.after_mean,
                shift_sd: fit.shift_sd,
            }
        })
        .collect()
}

fn collect_change_points(
    values: &[f64],
    offset: usize,
    depth: usize,
    out: &mut Vec<(usize, stats::ChangePointFit)>,
) {
    if depth == 0 || values.len() < 2 * CHANGEPOINT_MIN_SEGMENT {
        return;
    }
    let Some(fit) = stats::change_point(values, CHANGEPOINT_MIN_SEGMENT, CHANGEPOINT_MAX_SHIFT_SD)
    else {
        return;
    };
    if fit.shift_sd < CHANGEPOINT_MIN_SHIFT_SD {
        return;
    }
    out.push((offset, fit));
    let k = fit.index;
    collect_change_points(&values[..k], offset, depth - 1, out);
    collect_change_points(&values[k..], offset + k, depth - 1, out);
}

/// Positions where `a` and `b` swap which is larger. Rows where either series
/// is missing are skipped, and the comparison is carried across the gap from
/// the last row where BOTH were present -- otherwise a hole silently reads as
/// a crossing.
pub fn crossover_facts(
    a: &Subject,
    b: &Subject,
    labels: &[String],
    a_values: &[f64],
    b_values: &[f64],
) -> Vec<FactKind> {
    let mut out = Vec::new();
    let mut previous_sign: Option<f64> = None;
    let n = a_values.len().min(b_values.len());
    for i in 0..n {
        let (x, y) = (a_values[i], b_values[i]);
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        let diff = x - y;
        if diff == 0.0 {
            continue;
        }
        let sign = diff.signum();
        if let Some(prev) = previous_sign {
            if prev != sign {
                out.push(FactKind::Crossover {
                    a: a.clone(),
                    b: b.clone(),
                    at_label: labels
                        .get(i)
                        .cloned()
                        .unwrap_or_else(|| (i + 1).to_string()),
                    at_index: i,
                });
                if out.len() >= CROSSOVER_MAX_REPORTED {
                    return out;
                }
            }
        }
        previous_sign = Some(sign);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("P{i}")).collect()
    }

    fn series(name: &str, values: Vec<f64>) -> Series {
        let l = labels(values.len());
        Series::new(Subject::measure(name), &l, &values)
    }

    #[test]
    fn a_pure_linear_series_reports_its_exact_slope_and_an_r2_of_one() {
        let s = series("Revenue", (0..10).map(|i| 100.0 + 25.0 * i as f64).collect());
        let fact = trend_fact(&s).expect("a perfect ramp must produce a trend");
        match fact {
            FactKind::Trend {
                slope_per_step,
                r2,
                first,
                last,
                n,
                direction,
                ..
            } => {
                assert!((slope_per_step - 25.0).abs() < 1e-9, "slope {slope_per_step}");
                assert!((r2 - 1.0).abs() < 1e-12, "r2 {r2}");
                assert_eq!((first, last, n), (100.0, 325.0, 10));
                assert_eq!(direction, Direction::Rising);
            }
            other => panic!("expected a trend, got {other:?}"),
        }
    }

    #[test]
    fn a_constant_series_produces_no_trend_and_a_rising_one_does() {
        let flat = series("Flat", vec![50.0; 20]);
        assert!(trend_fact(&flat).is_none());
        assert!(change_fact(&flat).is_none());
        assert!(extremes_fact(&flat).is_none());
        assert!(smoothed_peak_fact(&flat).is_none());

        let rising = series("Rising", (0..20).map(|i| 50.0 + 3.0 * i as f64).collect());
        assert!(trend_fact(&rising).is_some(), "positive control failed");
        assert!(change_fact(&rising).is_some());
        assert!(extremes_fact(&rising).is_some());
    }

    #[test]
    fn a_clean_fit_with_a_trivial_slope_is_not_reported_as_a_trend() {
        // Perfect r2, but the whole series moves 0.9 on a level of 1000.
        let s = series("Barely", (0..20).map(|i| 1000.0 + 0.05 * i as f64).collect());
        let fit = stats::ols_over_index(&s.values).unwrap();
        assert!((fit.r2 - 1.0).abs() < 1e-9, "the fit itself must be perfect");
        assert!(trend_fact(&s).is_none(), "a 0.1% move is not a trend");
    }

    #[test]
    fn a_sine_of_period_twelve_is_detected_at_lag_twelve_and_not_at_four_or_seven() {
        let values: Vec<f64> = (0..60)
            .map(|i| 100.0 + 10.0 * (std::f64::consts::TAU * i as f64 / 12.0).sin())
            .collect();
        let s = series("Seasonal", values);

        let scan = seasonality_scan(&s);
        for (lag, acf) in &scan {
            if *lag == 12 {
                assert!(*acf >= SEASONALITY_MIN_ACF, "lag 12 acf {acf}");
            } else {
                assert!(*acf < SEASONALITY_MIN_ACF, "lag {lag} acf {acf} passed the bar");
            }
        }

        match seasonality_fact(&s).expect("a 12-point cycle must be found") {
            FactKind::Seasonality { lag, acf, .. } => {
                assert_eq!(lag, 12);
                assert!(acf >= SEASONALITY_MIN_ACF);
            }
            other => panic!("expected seasonality, got {other:?}"),
        }
    }

    #[test]
    fn a_ramp_reports_no_seasonality_at_any_lag() {
        let s = series("Ramp", (0..60).map(|i| i as f64).collect());
        assert!(seasonality_fact(&s).is_none());
    }

    #[test]
    fn a_step_change_is_located_within_one_period_of_the_step() {
        let mut values: Vec<f64> = Vec::new();
        for i in 0..15 {
            // Deterministic sawtooth jitter so the segments are not exactly
            // flat -- an exactly flat pair would take the clamped-shift path
            // and prove nothing about locating the step in real data.
            values.push(100.0 + (i % 3) as f64);
        }
        for i in 0..15 {
            values.push(140.0 + (i % 3) as f64);
        }
        let s = series("Stepped", values);
        let facts = change_point_facts(&s);
        assert!(!facts.is_empty(), "a 40-unit step must be found");
        match &facts[0] {
            FactKind::ChangePoint {
                at_index,
                before_mean,
                after_mean,
                shift_sd,
                ..
            } => {
                assert!(
                    at_index.abs_diff(15) <= 1,
                    "step located at {at_index}, expected 15 +/- 1"
                );
                assert!(*before_mean < *after_mean);
                assert!(*shift_sd >= CHANGEPOINT_MIN_SHIFT_SD);
            }
            other => panic!("expected a change point, got {other:?}"),
        }
        assert!(facts.len() <= CHANGEPOINT_MAX);
    }

    #[test]
    fn a_ramp_also_splits_which_is_why_the_pipeline_prefers_its_trend() {
        // Binary segmentation on a pure ramp DOES clear the shift bar: the two
        // halves of a straight line have well-separated means. That is a
        // property of the method, not a bug in it, and the fix belongs one
        // level up -- `analyze` drops change points for any series that already
        // produced a `Trend`, because a line and a step are competing
        // explanations of the same picture and printing both is noise.
        // `analyze_does_not_report_a_level_shift_for_a_plain_ramp` is the other
        // half of this pair.
        let s = series("Smooth", (0..30).map(|i| 100.0 + 0.5 * i as f64).collect());
        let facts = change_point_facts(&s);
        assert!(
            !facts.is_empty(),
            "if this ever becomes empty the suppression in analyze() is dead code"
        );
        assert!(trend_fact(&s).is_some());
    }

    #[test]
    fn a_crossing_is_reported_where_the_larger_series_changes() {
        let a: Vec<f64> = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let b: Vec<f64> = vec![6.0, 5.0, 4.0, 3.0, 2.0, 1.0];
        let l = labels(6);
        let facts = crossover_facts(
            &Subject::measure("A"),
            &Subject::measure("B"),
            &l,
            &a,
            &b,
        );
        assert_eq!(facts.len(), 1);
        match &facts[0] {
            FactKind::Crossover { at_index, at_label, .. } => {
                assert_eq!(*at_index, 3);
                assert_eq!(at_label, "P4");
            }
            other => panic!("expected a crossover, got {other:?}"),
        }
    }

    #[test]
    fn two_series_that_never_swap_produce_no_crossing() {
        let a: Vec<f64> = (0..10).map(|i| 100.0 + i as f64).collect();
        let b: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let l = labels(10);
        assert!(crossover_facts(&Subject::measure("A"), &Subject::measure("B"), &l, &a, &b).is_empty());
    }

    #[test]
    fn a_gap_keeps_its_label_attached_to_the_right_value() {
        let l = vec!["Jan".to_string(), "Feb".to_string(), "Mar".to_string()];
        let s = Series::new(Subject::measure("V"), &l, &[1.0, f64::NAN, 3.0]);
        assert_eq!(s.values, vec![1.0, 3.0]);
        assert_eq!(s.labels, vec!["Jan".to_string(), "Mar".to_string()]);
    }
}
