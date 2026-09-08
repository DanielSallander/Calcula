//! FILENAME: core/insights/src/thresholds.rs
// PURPOSE: Every number that decides whether a fact is worth saying, in one place.
// CONTEXT: A threshold buried at its call site is a threshold nobody can argue
// with. Each constant below carries the reason it has the value it has, because
// the only way to tune "analyze this data" without turning it into noise is to
// be able to read the whole tuning surface at once. Nothing in this crate may
// compare against a bare literal -- if a new rule needs a number, it gets a
// named constant here first.

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/// A reader stops reading a bullet list somewhere around a dozen items, and an
/// analysis that says twenty things has said nothing. Everything past this is
/// counted in `InsightBundle::dropped` rather than silently discarded.
pub const MAX_INSIGHTS: usize = 12;

/// Without a per-kind cap the highest-scoring KIND eats the whole budget: a
/// twelve-column table produces twelve trend facts and no outliers, no
/// correlations and no hygiene warnings. Three of anything is enough to
/// establish a pattern.
pub const MAX_PER_KIND: usize = 3;

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/// Fewer than six points cannot distinguish a trend from two noisy readings.
/// A five-point "trend" is the single most common false positive in this class
/// of tool.
pub const MIN_POINTS_FOR_TREND: usize = 6;

/// The straight line must account for at least half the variation before the
/// word "rising" is used. Below this the series is better described by its
/// spread than by its slope.
pub const TREND_MIN_R2: f64 = 0.5;

/// A statistically clean slope can still be trivial: 0.4% growth over a year
/// fits a line perfectly and means nothing. The total movement across the whole
/// series must be at least a tenth of the typical level.
pub const TREND_MIN_TOTAL_CHANGE_SHARE: f64 = 0.10;

/// First-to-last change smaller than 5% is reported as "flat" rather than as a
/// change, matching how a finance reader rounds.
pub const PCT_CHANGE_MIN_ABS: f64 = 0.05;

/// Below this many points a first/last comparison is just two numbers, and
/// `Change` would repeat `ColumnSummary`'s min and max.
pub const CHANGE_MIN_POINTS: usize = 3;

/// `Extremes` names a best and a worst label, so it needs at least a small
/// field to pick from -- with two points it degenerates into `Change`.
pub const EXTREMES_MIN_POINTS: usize = 4;

// ---------------------------------------------------------------------------
// Smoothing / seasonality
// ---------------------------------------------------------------------------

/// Centred three-point smoothing: the smallest window that removes single-point
/// spikes without moving a genuine peak by more than one position.
pub const SMOOTHING_WINDOW: usize = 3;

/// A smoothed peak needs enough room on both sides of the window for the peak
/// to be interior rather than an artefact of where the data starts.
pub const SMOOTHED_PEAK_MIN_POINTS: usize = 9;

/// Quarters, weekdays and months -- the three cycle lengths that actually occur
/// in a spreadsheet. Scanning every lag up to n/2 finds a "cycle" in noise.
pub const SEASONALITY_LAGS: [usize; 3] = [4, 7, 12];

/// Autocorrelation below this is not a cycle a reader would recognise on the
/// chart, and saying "repeats every 7 points" about it is a lie by confidence.
pub const SEASONALITY_MIN_ACF: f64 = 0.5;

/// One cycle is not a repetition. Two is the minimum that can repeat at all.
pub const SEASONALITY_MIN_CYCLES: usize = 2;

/// The detrended residuals must keep at least this share of the original
/// variance before their autocorrelation means anything.
///
/// This is not a stylistic epsilon. Removing the straight line from a series
/// that IS a straight line leaves residuals made of floating-point dust --
/// around 1e-26 of the original variance -- and the autocorrelation of dust is
/// an arbitrary number in -1..1. Without this guard a perfectly linear column
/// reports a 4-, 7- or 12-point "cycle" depending on nothing but rounding.
pub const SEASONALITY_MIN_RESIDUAL_VARIANCE_SHARE: f64 = 1e-9;

// ---------------------------------------------------------------------------
// Change points
// ---------------------------------------------------------------------------

/// Both sides of a split must be long enough to have a mean worth comparing.
/// With a shorter segment the "level shift" is one outlier wearing a hat.
pub const CHANGEPOINT_MIN_SEGMENT: usize = 4;

/// The step must be one and a half pooled standard deviations to be visible on
/// the chart the user is looking at. Smaller steps are inside the noise band.
pub const CHANGEPOINT_MIN_SHIFT_SD: f64 = 1.5;

/// Two level shifts in one series is already a story; three is a different
/// series and the user should be looking at a chart, not a bullet list.
pub const CHANGEPOINT_MAX: usize = 2;

/// A trend and a level shift are competing explanations of one picture, and
/// only the better one should be printed. Above this fit the series is a line
/// and the split segmentation finds in it is an artefact -- the two halves of
/// any straight line have well-separated means.
///
/// The bar is high on purpose. A clean 15-then-15 step still fits a straight
/// line at R-squared of about 0.75, so a lower bar would describe a jump as a
/// gentle trend and throw away the one thing the reader wants: WHERE it jumped.
pub const CHANGEPOINT_SUPPRESSED_ABOVE_R2: f64 = 0.95;

/// A perfectly flat run followed by another perfectly flat run has a pooled
/// standard deviation of exactly zero, so the shift in SDs is infinite. That
/// matters here and not merely as a numeric nicety: `serde_json` writes a
/// non-finite `f64` as `null`, so an un-clamped infinity would put a HOLE in
/// `facts_json` at exactly the strongest fact in the bundle. Clamp instead.
pub const CHANGEPOINT_MAX_SHIFT_SD: f64 = 99.0;

// ---------------------------------------------------------------------------
// Outliers
// ---------------------------------------------------------------------------

/// Quartiles of seven points are three points, and every dataset that small has
/// something "outside the fences".
pub const OUTLIER_MIN_N: usize = 8;

/// Tukey's fence. The convention every statistics text and every box plot uses,
/// so a user who checks our answer against a box plot gets the same points.
pub const OUTLIER_IQR_K: f64 = 1.5;

/// Tukey's "far out" fence -- reported as a stronger method label so the
/// narration can distinguish a mild outlier from an implausible one.
pub const OUTLIER_IQR_K_EXTREME: f64 = 3.0;

/// Three sigma. Only meaningful once the sample is big enough for the mean and
/// the standard deviation not to be dragged by the outlier itself.
pub const OUTLIER_Z: f64 = 3.0;

/// Below thirty points a single extreme value moves the mean and inflates the
/// standard deviation enough to hide itself, so the quartile method is used
/// instead -- quartiles do not move when the tail does.
pub const OUTLIER_Z_MIN_N: usize = 30;

/// Naming more than three points turns an insight into a data dump; the total
/// count is still reported so nothing is hidden.
pub const OUTLIER_MAX_REPORTED: usize = 3;

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/// Correlation on seven pairs is a coin flip: |r| >= 0.7 happens by chance on
/// small samples often enough to be worthless.
pub const CORRELATION_MIN_N: usize = 8;

/// Roughly half the variance shared (r^2 >= 0.49). Below this the scatter plot
/// looks like a cloud and the sentence would overstate it.
pub const CORRELATION_MIN_ABS_R: f64 = 0.7;

/// Pairs grow quadratically with columns; three is the most that can be read
/// before the list stops being about the data and starts being about columns.
pub const CORRELATION_MAX_PAIRS: usize = 3;

/// Only the first few numeric columns are scanned for crossings; every extra
/// column multiplies the pair count without adding a distinguishable story.
pub const CROSSOVER_MAX_COLUMNS: usize = 4;

/// Two crossings is "they swapped and swapped back". More than that is an
/// oscillation, which `Seasonality` describes better.
pub const CROSSOVER_MAX_REPORTED: usize = 2;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/// Below 40% the top category is merely the largest, not dominant, and calling
/// it dominant misleads a reader who has not seen the other 60%.
pub const DOMINANCE_MIN_SHARE: f64 = 0.4;

/// Past fifty categories "the top one is 40%" stops being a summary of the
/// breakdown and becomes a summary of one row.
pub const DOMINANCE_MAX_CATEGORIES: usize = 50;

/// The Pareto question: how few categories reach this share of the total.
pub const PARETO_TARGET: f64 = 0.8;

/// If it takes more than a third of the categories to reach 80%, the
/// distribution is flat and there is no Pareto effect to report.
pub const PARETO_MAX_CATEGORY_FRACTION: f64 = 0.35;

/// "Two of four categories make 80%" is arithmetic, not a finding.
pub const PARETO_MIN_CATEGORIES: usize = 5;

/// Same 40% bar as `DOMINANCE_MIN_SHARE`, applied across whole series rather
/// than across the values of one category column.
pub const LEADER_MIN_SHARE: f64 = 0.4;

/// A leader needs something to lead.
pub const LEADER_MIN_SERIES: usize = 3;

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

/// One repeated row is a coincidence a user can see; two is a pattern worth a
/// warning.
pub const DUPLICATE_MIN_ROWS: usize = 2;

/// A column that is 100% numbers with one stray label is a typo, not a mixed
/// type. Both sides must carry at least a tenth of the column.
pub const MIXED_TYPES_MIN_MINORITY_SHARE: f64 = 0.10;

/// How many of a text column's most frequent values get named. Three fits in
/// one sentence; a longer list is a frequency table, and the distinct count
/// already tells the reader how much is being left out.
pub const TEXT_SUMMARY_TOP_VALUES: usize = 3;

// ---------------------------------------------------------------------------
// Scoring
//
// Every score is `base * (0.5 + 0.5 * strength)` where strength is a
// kind-specific 0..1 measure, so a weak instance of a strong kind can still
// lose to a strong instance of a weaker one. The bases are ordered by "what
// would a reader want to know first if they could only read one line".
// ---------------------------------------------------------------------------

/// Orientation first: how big is this and does it have a header. Everything
/// else is unreadable without it, so it outranks even a data-quality warning.
pub const SCORE_SHAPE: f64 = 0.95;
/// A cell holding `#REF!` invalidates every number computed from it, so a data
/// error outranks any finding drawn from the data.
pub const SCORE_ERRORS: f64 = 0.92;
pub const SCORE_TREND: f64 = 0.85;
pub const SCORE_CHANGE_POINT: f64 = 0.80;
pub const SCORE_SEASONALITY: f64 = 0.75;
pub const SCORE_CORRELATION: f64 = 0.72;
pub const SCORE_OUTLIERS: f64 = 0.70;
pub const SCORE_DOMINANCE: f64 = 0.65;
pub const SCORE_PARETO: f64 = 0.62;
pub const SCORE_CHANGE: f64 = 0.60;
pub const SCORE_LEADER: f64 = 0.58;
pub const SCORE_DUPLICATES: f64 = 0.55;
pub const SCORE_CROSSOVER: f64 = 0.54;
pub const SCORE_MIXED_TYPES: f64 = 0.50;
pub const SCORE_EXTREMES: f64 = 0.45;
pub const SCORE_SMOOTHED_PEAK: f64 = 0.40;
pub const SCORE_BLANK_ROWS: f64 = 0.35;
pub const SCORE_BOOLEAN_SHARE: f64 = 0.32;
pub const SCORE_COLUMN_SUMMARY: f64 = 0.30;
pub const SCORE_TEXT_SUMMARY: f64 = 0.28;

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/// Stamped into every bundle. A consumer that cached a bundle can tell that the
/// thresholds above moved under it; bump this whenever any of them changes.
pub const INSIGHTS_ENGINE_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Relationships between thresholds that must hold for a rule to be live at all.
// These are COMPILE-TIME assertions rather than tests: a per-kind cap above the
// total budget does not fail a run, it silently turns the per-kind rule into
// dead code, and the point of catching that is to catch it before it ships.
// ---------------------------------------------------------------------------

const _: () = assert!(MAX_PER_KIND <= MAX_INSIGHTS);
const _: () = assert!(MAX_PER_KIND > 0);
const _: () = assert!(MAX_INSIGHTS > 0);
const _: () = assert!(OUTLIER_IQR_K_EXTREME > OUTLIER_IQR_K);
const _: () = assert!(CHANGEPOINT_SUPPRESSED_ABOVE_R2 > TREND_MIN_R2);
const _: () = assert!(OUTLIER_MAX_REPORTED > 0);
const _: () = assert!(CHANGEPOINT_MIN_SEGMENT > 1);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_threshold_is_inside_the_range_its_rule_can_use() {
        // Shares and correlations are fractions; a value outside 0..=1 would
        // silently disable the rule rather than fail, which is the failure mode
        // this test exists to prevent.
        for (name, v) in [
            ("TREND_MIN_R2", TREND_MIN_R2),
            ("TREND_MIN_TOTAL_CHANGE_SHARE", TREND_MIN_TOTAL_CHANGE_SHARE),
            ("PCT_CHANGE_MIN_ABS", PCT_CHANGE_MIN_ABS),
            ("SEASONALITY_MIN_ACF", SEASONALITY_MIN_ACF),
            ("CORRELATION_MIN_ABS_R", CORRELATION_MIN_ABS_R),
            ("DOMINANCE_MIN_SHARE", DOMINANCE_MIN_SHARE),
            ("PARETO_TARGET", PARETO_TARGET),
            ("PARETO_MAX_CATEGORY_FRACTION", PARETO_MAX_CATEGORY_FRACTION),
            ("LEADER_MIN_SHARE", LEADER_MIN_SHARE),
            ("MIXED_TYPES_MIN_MINORITY_SHARE", MIXED_TYPES_MIN_MINORITY_SHARE),
        ] {
            assert!((0.0..=1.0).contains(&v), "{name} must be a fraction, got {v}");
        }
    }

    #[test]
    fn a_seasonal_lag_always_needs_more_points_than_the_trend_minimum() {
        // Otherwise a lag could be tested on a series too short to have a slope
        // removed from it, and the ACF would be measuring the trend.
        let shortest = SEASONALITY_LAGS.iter().copied().min().unwrap() * SEASONALITY_MIN_CYCLES;
        assert!(shortest >= MIN_POINTS_FOR_TREND);
    }
}
