//! FILENAME: core/insights/src/stats.rs
// PURPOSE: The arithmetic. Pure functions over `&[f64]`, no types from this
// crate, no allocation of anything a caller can see.
// CONTEXT: No types from this crate cross into this file -- the one exception
// is a single threshold constant, named and justified in `thresholds.rs`.
// Everything here returns `Option` and returns `None` for the
// degenerate case rather than a plausible number. That is the whole discipline
// of this file: a constant column has no correlation, no slope worth quoting
// and no fraction of variance accounted for, and every one of those is a
// division by zero that a naive implementation reports as 0, 1 or NaN. Each of
// the three would put a sentence in front of the user that is not true.

use std::cmp::Ordering;

use crate::thresholds::SEASONALITY_MIN_RESIDUAL_VARIANCE_SHARE;

/// Total-order comparison for sorting. Every function here filters non-finite
/// values first, so this only has to be defined, not correct for NaN.
fn cmp_f64(a: &f64, b: &f64) -> Ordering {
    a.partial_cmp(b).unwrap_or(Ordering::Equal)
}

pub fn finite(values: &[f64]) -> Vec<f64> {
    values.iter().copied().filter(|v| v.is_finite()).collect()
}

pub fn sorted_finite(values: &[f64]) -> Vec<f64> {
    let mut v = finite(values);
    v.sort_by(cmp_f64);
    v
}

pub fn sum(values: &[f64]) -> f64 {
    values.iter().copied().filter(|v| v.is_finite()).sum()
}

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

/// Welford's online mean and sum of squared deviations. Chosen over the
/// textbook `sum(x^2) - n*mean^2` because that form loses every significant
/// digit on data like `[1e9, 1e9+1, 1e9+2]` -- a currency column with a large
/// base is exactly that shape, and the naive variance there comes out negative.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Moments {
    pub n: usize,
    pub mean: f64,
    /// Sum of squared deviations from the running mean.
    pub m2: f64,
}

impl Moments {
    pub fn of(values: &[f64]) -> Moments {
        let mut m = Moments::default();
        for &x in values {
            m.push(x);
        }
        m
    }

    pub fn push(&mut self, x: f64) {
        if !x.is_finite() {
            return;
        }
        self.n += 1;
        let delta = x - self.mean;
        self.mean += delta / self.n as f64;
        self.m2 += delta * (x - self.mean);
    }

    pub fn variance_sample(&self) -> Option<f64> {
        if self.n < 2 {
            None
        } else {
            Some(self.m2 / (self.n - 1) as f64)
        }
    }

    pub fn variance_population(&self) -> Option<f64> {
        if self.n == 0 {
            None
        } else {
            Some(self.m2 / self.n as f64)
        }
    }

    pub fn stdev_sample(&self) -> Option<f64> {
        self.variance_sample().map(f64::sqrt)
    }
}

pub fn mean(values: &[f64]) -> Option<f64> {
    let m = Moments::of(values);
    if m.n == 0 {
        None
    } else {
        Some(m.mean)
    }
}

pub fn stdev_sample(values: &[f64]) -> Option<f64> {
    Moments::of(values).stdev_sample()
}

/// Mean of absolute values. Used as the SCALE a change is measured against:
/// dividing by the plain mean explodes when a series straddles zero, and a
/// series that runs -50, 0, +50 is not one with "infinite" relative change.
pub fn mean_abs(values: &[f64]) -> Option<f64> {
    let abs: Vec<f64> = finite(values).iter().map(|v| v.abs()).collect();
    mean(&abs)
}

// ---------------------------------------------------------------------------
// Order statistics -- Excel's QUARTILE.INC / PERCENTILE.INC interpolation
// ---------------------------------------------------------------------------

/// `PERCENTILE.INC`: linear interpolation between the two order statistics
/// straddling `p * (n - 1)`. Matching Excel exactly matters here because a user
/// who checks our fences with `=QUARTILE.INC(A:A,1)` must get the same number,
/// and the six other quartile definitions in circulation all disagree by
/// enough to move a fence past a real point.
pub fn percentile_inc(values: &[f64], p: f64) -> Option<f64> {
    if !(0.0..=1.0).contains(&p) {
        return None;
    }
    let sorted = sorted_finite(values);
    if sorted.is_empty() {
        return None;
    }
    if sorted.len() == 1 {
        return Some(sorted[0]);
    }
    let pos = p * (sorted.len() - 1) as f64;
    let lower = pos.floor() as usize;
    let frac = pos - lower as f64;
    if lower + 1 >= sorted.len() {
        Some(sorted[sorted.len() - 1])
    } else {
        Some(sorted[lower] + frac * (sorted[lower + 1] - sorted[lower]))
    }
}

/// `QUARTILE.INC(values, quart)` for quart 0..=4.
pub fn quartile_inc(values: &[f64], quart: u8) -> Option<f64> {
    if quart > 4 {
        return None;
    }
    percentile_inc(values, quart as f64 / 4.0)
}

pub fn median(values: &[f64]) -> Option<f64> {
    percentile_inc(values, 0.5)
}

pub fn min_max(values: &[f64]) -> Option<(f64, f64)> {
    let sorted = sorted_finite(values);
    if sorted.is_empty() {
        None
    } else {
        Some((sorted[0], sorted[sorted.len() - 1]))
    }
}

// ---------------------------------------------------------------------------
// Association
// ---------------------------------------------------------------------------

/// Pearson correlation over PAIRWISE-COMPLETE rows: a row is used only when
/// both series have a finite value there. Dropping holes per series instead
/// would slide one column against the other and correlate row 4 with row 7.
pub fn pearson(xs: &[f64], ys: &[f64]) -> Option<f64> {
    let pairs = complete_pairs(xs, ys);
    if pairs.len() < 2 {
        return None;
    }
    let (mx, my) = pair_means(&pairs);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for &(x, y) in &pairs {
        let dx = x - mx;
        let dy = y - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if sxx <= 0.0 || syy <= 0.0 {
        // A constant series has no correlation with anything. Returning 0 here
        // would be read as "no relationship measured", which is a different and
        // wrong claim.
        return None;
    }
    Some((sxy / (sxx * syy).sqrt()).clamp(-1.0, 1.0))
}

/// How many rows `pearson` would actually use.
pub fn paired_n(xs: &[f64], ys: &[f64]) -> usize {
    complete_pairs(xs, ys).len()
}

fn complete_pairs(xs: &[f64], ys: &[f64]) -> Vec<(f64, f64)> {
    xs.iter()
        .zip(ys.iter())
        .filter(|(x, y)| x.is_finite() && y.is_finite())
        .map(|(x, y)| (*x, *y))
        .collect()
}

fn pair_means(pairs: &[(f64, f64)]) -> (f64, f64) {
    let n = pairs.len() as f64;
    let sx: f64 = pairs.iter().map(|p| p.0).sum();
    let sy: f64 = pairs.iter().map(|p| p.1).sum();
    (sx / n, sy / n)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinearFit {
    pub slope: f64,
    pub intercept: f64,
    /// Fraction of the variation in y accounted for by the line.
    pub r2: f64,
}

/// Ordinary least squares. `None` when x does not vary (no line is determined)
/// or when y does not vary.
///
/// The y case is the important one: a perfectly flat column fits a horizontal
/// line perfectly, so the tempting answer is `r2 = 1`. Reporting that means a
/// column that never moves gets described as a trend with a flawless fit.
/// Excel's `RSQ` answers `#DIV/0!` on the same input, and `None` is this
/// crate's spelling of that.
pub fn ols(xs: &[f64], ys: &[f64]) -> Option<LinearFit> {
    let pairs = complete_pairs(xs, ys);
    if pairs.len() < 2 {
        return None;
    }
    let (mx, my) = pair_means(&pairs);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for &(x, y) in &pairs {
        let dx = x - mx;
        let dy = y - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if sxx <= 0.0 || syy <= 0.0 {
        return None;
    }
    let slope = sxy / sxx;
    let intercept = my - slope * mx;
    let r2 = ((sxy * sxy) / (sxx * syy)).clamp(0.0, 1.0);
    Some(LinearFit { slope, intercept, r2 })
}

/// OLS of a series against its own 0-based position.
pub fn ols_over_index(ys: &[f64]) -> Option<LinearFit> {
    let xs: Vec<f64> = (0..ys.len()).map(|i| i as f64).collect();
    ols(&xs, ys)
}

// ---------------------------------------------------------------------------
// Time-series shape
// ---------------------------------------------------------------------------

/// Residuals after removing the straight line through the series.
///
/// Detrending before the autocorrelation is not optional. A rising series
/// autocorrelates near 1.0 at EVERY lag simply from the trend, so an un-
/// detrended scan reports "a 4-point cycle, a 7-point cycle and a 12-point
/// cycle" on data that has no cycle at all.
pub fn detrended_residuals(values: &[f64]) -> Vec<f64> {
    match ols_over_index(values) {
        Some(fit) => values
            .iter()
            .enumerate()
            .map(|(i, v)| v - (fit.intercept + fit.slope * i as f64))
            .collect(),
        None => {
            let m = mean(values).unwrap_or(0.0);
            values.iter().map(|v| v - m).collect()
        }
    }
}

/// Autocorrelation at `lag` of the linearly detrended series, using the biased
/// (divide-by-n) estimator. Biased on purpose: the unbiased form can exceed 1
/// at long lags on short series, and a "correlation" of 1.4 is not something a
/// narration can honestly render.
///
/// `None` when the line already accounts for essentially all of the series --
/// see `SEASONALITY_MIN_RESIDUAL_VARIANCE_SHARE` for why that case must be
/// refused rather than answered.
pub fn autocorrelation_detrended(values: &[f64], lag: usize) -> Option<f64> {
    if lag == 0 {
        return None;
    }
    let clean = finite(values);
    if clean.len() <= lag + 1 {
        return None;
    }
    let series_mean = mean(&clean)?;
    let series_ss: f64 = clean
        .iter()
        .map(|v| (v - series_mean) * (v - series_mean))
        .sum();
    let residuals = detrended_residuals(&clean);
    let m = mean(&residuals)?;
    let denom: f64 = residuals.iter().map(|r| (r - m) * (r - m)).sum();
    if denom <= 0.0
        || series_ss <= 0.0
        || denom / series_ss < SEASONALITY_MIN_RESIDUAL_VARIANCE_SHARE
    {
        return None;
    }
    let mut numer = 0.0;
    for i in lag..residuals.len() {
        numer += (residuals[i] - m) * (residuals[i - lag] - m);
    }
    Some((numer / denom).clamp(-1.0, 1.0))
}

/// Centred moving average. `None` at positions where the window would run off
/// either end -- padding those with a shorter window makes the smoothed series
/// bend at its ends and moves the reported peak.
pub fn moving_average(values: &[f64], window: usize) -> Vec<Option<f64>> {
    if window == 0 || window > values.len() {
        return vec![None; values.len()];
    }
    let half = (window - 1) / 2;
    (0..values.len())
        .map(|i| {
            let start = i.checked_sub(half)?;
            let end = start + window;
            if end > values.len() {
                return None;
            }
            let slice = &values[start..end];
            if slice.iter().any(|v| !v.is_finite()) {
                return None;
            }
            Some(slice.iter().sum::<f64>() / window as f64)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fences {
    pub q1: f64,
    pub q3: f64,
    pub iqr: f64,
    pub low: f64,
    pub high: f64,
}

pub fn iqr_fences(values: &[f64], k: f64) -> Option<Fences> {
    let q1 = quartile_inc(values, 1)?;
    let q3 = quartile_inc(values, 3)?;
    let iqr = q3 - q1;
    Some(Fences {
        q1,
        q3,
        iqr,
        low: q1 - k * iqr,
        high: q3 + k * iqr,
    })
}

// ---------------------------------------------------------------------------
// Change point
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChangePointFit {
    /// Index of the FIRST element of the second segment.
    pub index: usize,
    pub before_mean: f64,
    pub after_mean: f64,
    /// Gap between the two means in pooled sample standard deviations, clamped
    /// to `max_shift_sd`.
    pub shift_sd: f64,
    /// Between-group sum of squares at the winning split -- the quantity that
    /// was maximised, kept so a caller can compare two candidate splits.
    pub between_ss: f64,
}

/// Single-split binary segmentation: the split that maximises the between-group
/// sum of squares `n1*(m1-m)^2 + n2*(m2-m)^2`.
///
/// Ties keep the EARLIEST split (the comparison is strictly greater), so a
/// perfectly symmetric series always reports the same index. Without that, the
/// answer depended on iteration order and "byte-identical across runs" would
/// have been true only by luck.
pub fn change_point(
    values: &[f64],
    min_segment: usize,
    max_shift_sd: f64,
) -> Option<ChangePointFit> {
    let v = finite(values);
    let n = v.len();
    if min_segment == 0 || n < 2 * min_segment {
        return None;
    }
    let grand = mean(&v)?;

    // Prefix sums make the scan linear; the winning split's variances are then
    // recomputed exactly from the slices, so precision loss in the prefix scan
    // can only pick a slightly different split, never corrupt the reported
    // means.
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + v[i];
    }

    let mut best: Option<(usize, f64)> = None;
    for k in min_segment..=(n - min_segment) {
        let n1 = k as f64;
        let n2 = (n - k) as f64;
        let m1 = prefix[k] / n1;
        let m2 = (prefix[n] - prefix[k]) / n2;
        let between = n1 * (m1 - grand) * (m1 - grand) + n2 * (m2 - grand) * (m2 - grand);
        let better = match best {
            None => true,
            Some((_, b)) => between > b,
        };
        if better {
            best = Some((k, between));
        }
    }

    let (k, between_ss) = best?;
    let left = &v[..k];
    let right = &v[k..];
    let ml = Moments::of(left);
    let mr = Moments::of(right);
    let vl = ml.variance_sample().unwrap_or(0.0);
    let vr = mr.variance_sample().unwrap_or(0.0);
    // n > 2 is guaranteed for any min_segment >= 2, but min_segment 1 admits
    // n == 2 and the pooled denominator would be zero there.
    let pooled_var = if n > 2 {
        (((k - 1) as f64) * vl + ((n - k - 1) as f64) * vr) / (n as f64 - 2.0)
    } else {
        0.0
    };
    let pooled_sd = if pooled_var > 0.0 { pooled_var.sqrt() } else { 0.0 };
    let gap = (mr.mean - ml.mean).abs();
    let shift_sd = if pooled_sd > 0.0 {
        (gap / pooled_sd).min(max_shift_sd)
    } else if gap > 0.0 {
        // Two exactly flat runs at different levels. Infinity is the true
        // answer and an unusable one: `serde_json` writes a non-finite f64 as
        // `null`, which would leave a hole in `facts_json` at the strongest
        // fact in the bundle.
        max_shift_sd
    } else {
        0.0
    };

    Some(ChangePointFit {
        index: k,
        before_mean: ml.mean,
        after_mean: mr.mean,
        shift_sd,
        between_ss,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn welford_survives_a_large_offset_that_breaks_the_textbook_formula() {
        let base = 1e9;
        let values = [base, base + 1.0, base + 2.0, base + 3.0];
        let m = Moments::of(&values);
        assert!(close(m.mean, base + 1.5));
        // Sample variance of 0,1,2,3 is 5/3.
        assert!(close(m.variance_sample().unwrap(), 5.0 / 3.0));
    }

    #[test]
    fn quartiles_match_excels_inclusive_interpolation() {
        // =QUARTILE.INC({1;2;3;4},1) is 1.75 and quart 3 is 3.25 in Excel.
        let v = [1.0, 2.0, 3.0, 4.0];
        assert!(close(quartile_inc(&v, 1).unwrap(), 1.75));
        assert!(close(quartile_inc(&v, 2).unwrap(), 2.5));
        assert!(close(quartile_inc(&v, 3).unwrap(), 3.25));
        assert!(close(quartile_inc(&v, 0).unwrap(), 1.0));
        assert!(close(quartile_inc(&v, 4).unwrap(), 4.0));
        assert!(close(median(&v).unwrap(), 2.5));
    }

    #[test]
    fn a_perfect_line_reports_its_exact_slope_and_an_r2_of_one() {
        let ys: Vec<f64> = (0..10).map(|i| 3.0 + 2.5 * i as f64).collect();
        let fit = ols_over_index(&ys).unwrap();
        assert!(close(fit.slope, 2.5), "slope was {}", fit.slope);
        assert!(close(fit.intercept, 3.0));
        assert!(close(fit.r2, 1.0));
    }

    #[test]
    fn a_constant_series_has_no_fit_and_no_correlation() {
        let flat = [7.0; 12];
        let rising: Vec<f64> = (0..12).map(|i| i as f64).collect();
        assert!(ols_over_index(&flat).is_none());
        assert!(pearson(&flat, &rising).is_none());
        // Positive control: the same call on data that DOES vary must answer.
        assert!(ols_over_index(&rising).is_some());
        assert!(close(pearson(&rising, &rising).unwrap(), 1.0));
    }

    #[test]
    fn correlation_pairs_rows_and_never_slides_one_column_against_the_other() {
        let xs = [1.0, f64::NAN, 3.0, 4.0];
        let ys = [2.0, 99.0, 6.0, 8.0];
        assert_eq!(paired_n(&xs, &ys), 3);
        assert!(close(pearson(&xs, &ys).unwrap(), 1.0));
    }

    #[test]
    fn autocorrelation_finds_the_period_of_a_sine_and_rejects_the_others() {
        let values: Vec<f64> = (0..60)
            .map(|i| (std::f64::consts::TAU * i as f64 / 12.0).sin())
            .collect();
        let at12 = autocorrelation_detrended(&values, 12).unwrap();
        let at4 = autocorrelation_detrended(&values, 4).unwrap();
        let at7 = autocorrelation_detrended(&values, 7).unwrap();
        assert!(at12 > 0.5, "lag 12 acf was {at12}");
        assert!(at4 < 0.5, "lag 4 acf was {at4}");
        assert!(at7 < 0.5, "lag 7 acf was {at7}");
    }

    #[test]
    fn a_perfect_ramp_has_no_autocorrelation_to_report_at_any_lag() {
        // The whole reason `detrended_residuals` exists: the raw ACF of a ramp
        // is near 1 everywhere. Removing the line leaves floating-point dust,
        // whose ACF is arbitrary -- so the answer must be a refusal, not a
        // number. Before the residual-variance guard this unwrapped to values
        // that varied with rounding.
        let ramp: Vec<f64> = (0..60).map(|i| i as f64).collect();
        for lag in [4usize, 7, 12] {
            assert_eq!(
                autocorrelation_detrended(&ramp, lag),
                None,
                "a pure line must report no cycle at lag {lag}"
            );
        }
    }

    #[test]
    fn a_line_whose_residuals_are_rounding_dust_still_reports_no_cycle() {
        // The integer ramp above leaves residuals of EXACTLY zero, so it is
        // caught by `denom <= 0.0` and proves nothing about the variance-share
        // guard. This one has to reach the share test instead, which means its
        // residuals must be non-zero dust.
        //
        // The dust is PLANTED rather than hoped for. An earlier version of this
        // test used `3.7 + 0.1 * i` and trusted that 0.1 being unrepresentable
        // in binary would leave a rounding remainder; on this target the least
        // squares fit cancelled exactly and the test failed on its own
        // precondition. A guard whose fixture depends on which way the floating
        // point unit happens to round is not a guard.
        let mut ramp: Vec<f64> = (0..60).map(|i| 3.7 + 0.1 * i as f64).collect();
        ramp[17] += 1e-13;
        let residuals = detrended_residuals(&ramp);
        assert!(
            residuals.iter().any(|r| *r != 0.0),
            "fixture must leave rounding dust, or this test cannot reach the guard"
        );
        // ...and the dust must be small enough that only the SHARE guard can
        // refuse it. If it were big enough to be real signal, the test would
        // pass for the wrong reason.
        let series_mean = mean(&ramp).unwrap();
        let series_ss: f64 = ramp.iter().map(|v| (v - series_mean).powi(2)).sum();
        let residual_ss: f64 = residuals.iter().map(|r| r * r).sum();
        assert!(
            residual_ss > 0.0 && residual_ss / series_ss < SEASONALITY_MIN_RESIDUAL_VARIANCE_SHARE,
            "dust share {} must be non-zero and below the guard",
            residual_ss / series_ss
        );
        for lag in [4usize, 7, 12] {
            assert_eq!(
                autocorrelation_detrended(&ramp, lag),
                None,
                "dust must not be reported as a cycle at lag {lag}"
            );
        }
    }

    #[test]
    fn a_noisy_ramp_still_answers_and_still_finds_no_cycle() {
        // Positive control for the guard above: real data with a trend must
        // still be measurable, or the guard would have silenced the whole rule.
        let wobble = [0.0, 4.0, -3.0, 1.0, -2.0];
        let ramp: Vec<f64> = (0..60)
            .map(|i| i as f64 + wobble[i % wobble.len()])
            .collect();
        for lag in [4usize, 7, 12] {
            let acf = autocorrelation_detrended(&ramp, lag)
                .unwrap_or_else(|| panic!("lag {lag} refused real data"));
            assert!(acf < 0.5, "lag {lag} on a noisy ramp reported {acf}");
        }
    }

    #[test]
    fn a_centred_moving_average_is_undefined_at_the_ends() {
        let v = [1.0, 2.0, 3.0, 4.0, 5.0];
        let ma = moving_average(&v, 3);
        assert_eq!(ma[0], None);
        assert_eq!(ma[4], None);
        assert!(close(ma[2].unwrap(), 3.0));
    }

    #[test]
    fn a_step_change_is_located_at_the_step() {
        let mut v: Vec<f64> = vec![10.0; 15];
        v.extend(vec![20.0; 15]);
        let fit = change_point(&v, 4, 99.0).unwrap();
        assert_eq!(fit.index, 15);
        assert!(close(fit.before_mean, 10.0));
        assert!(close(fit.after_mean, 20.0));
        // Two exactly flat runs: the true shift is infinite, and the clamp is
        // what keeps it out of `facts_json` as `null`.
        assert_eq!(fit.shift_sd, 99.0);
        assert!(fit.shift_sd.is_finite());
    }

    #[test]
    fn a_series_with_no_step_still_reports_the_best_split_but_a_tiny_shift() {
        let v: Vec<f64> = (0..30).map(|i| if i % 2 == 0 { 10.0 } else { 10.2 }).collect();
        let fit = change_point(&v, 4, 99.0).unwrap();
        assert!(fit.shift_sd < 1.5, "shift was {}", fit.shift_sd);
    }

    #[test]
    fn iqr_fences_collapse_onto_the_quartiles_when_the_data_is_constant() {
        let flat = [5.0; 10];
        let f = iqr_fences(&flat, 1.5).unwrap();
        assert!(close(f.iqr, 0.0));
        assert!(close(f.low, 5.0));
        assert!(close(f.high, 5.0));
    }
}
