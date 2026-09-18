//! FILENAME: app/src-tauri/src/insights/model.rs
// PURPOSE: The model-aware planner: decide what to ask the engine, and turn the
//          answers into facts that a measure's DECLARED meaning makes honest.
// CONTEXT: This is the file the whole programme exists for. A column of numbers
//          can be described; a MEASURE can be judged, because the strategy layer
//          says which way is good, how big a movement has to be before it is
//          worth a sentence, and whether the thing may be summed at all.
//
//          Everything below the "planning" section is PURE ARITHMETIC over
//          hand-buildable inputs. That is deliberate and it is the reason the
//          tests at the bottom run in milliseconds with no engine, no DataFusion
//          and no Tauri: the query half lives in `model_commands.rs`, which
//          fills in a `MeasureObservation` and hands it here. A defect in the
//          decomposition then fails for ONE reason, in one test, instead of
//          being buried under a query plan.
//
//          THREE GATES DECIDE WHETHER A SENTENCE IS TRUE, and each of them is a
//          separate refusal rather than a caveat bolted onto the prose:
//
//          (1) MATERIALITY gates `Change`. A movement the business already
//              called noise produces NO fact, not a quiet one.
//          (2) DIRECTION decides favourability, and a SUPPRESSED direction (Rule
//              4 in resolve.rs — a rule that covers only some of the members
//              this fact aggregates over and disagrees with the rest) produces a
//              fact that still carries its NUMBERS and carries no "better" or
//              "worse" at all. Half the company being told the opposite of the
//              truth is a worse outcome than a fact with one field missing.
//          (3) ADDITIVITY gates the share claim. A ratio has no share of a
//              total. "Gadgets accounts for 60% of the fall in Margin %" is
//              arithmetic nonsense stated with total confidence, and the
//              declared additivity is the only thing in the system that knows
//              it. A non-additive measure gets member MOVEMENTS and never a
//              share — see `contributions_for`.
//
//          Trend, change points and seasonality are NOT reimplemented here. They
//          are `core/insights` functions over a `Series`, already thresholded
//          and already tested; a second copy would drift in the direction of
//          whichever caller was edited last.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use engine::LocaleSettings;
use insights::narrate::number;
use insights::types::{AppliedAttr, AttrSource as CoreAttrSource, FactKind, Subject};
use insights::{narrate, timeseries};

use super::strategy::resolve::CalendarSource;
use super::strategy::{
    Additivity, AggregationSpec, Attribute, AttrSource, BandPlacement, BandSide, Direction,
    Cadence, Materiality, ModelFacts, QualifiedColumn, ResolvedMeasure, StrategyDoc,
    SuppressibleFactKind, Unit,
    Target,
};
use super::wire::{
    attr_source_id, BundleSource, EvidenceKind, WireBundle, WireEvidence, WireInsight,
    WireProvenance,
};

// ---------------------------------------------------------------------------
// The budget. Queries on one connection SERIALISE, so the plan is BOUNDED.
// ---------------------------------------------------------------------------

/// Measures analysed in one run.
pub const MAX_MEASURES_PER_RUN: usize = 12;

/// Analysis dimensions sliced per measure. One query each.
pub const MAX_DIMENSIONS_PER_MEASURE: usize = 4;

/// Periods pulled for the series. Enough for a 12-lag seasonality scan twice
/// over, and small enough that a daily axis does not turn into a table scan.
pub const MAX_PERIODS: usize = 24;

/// How deep a definitional decomposition walks into referenced measures.
pub const MAX_DRIVER_DEPTH: usize = 3;

/// Members named individually in a contribution before the rest collapse into
/// "everything else".
pub const CONTRIBUTION_TOP_N: usize = 5;

/// A contribution is only worth saying when the named members account for at
/// least this share of the total movement. Below it, the movement is spread
/// across the long tail and naming five members MISLEADS about where it came
/// from.
pub const CONTRIBUTION_MIN_EXPLAINED: f64 = 0.5;

/// ...and no more than this multiple of it.
///
/// The ceiling is not symmetry for its own sake. Six members that moved by
/// +100, -99, +98, -97, +96 and -95 have a NET movement of 3, and the top five
/// of them come to 98 — so they "explain" 3267% of it. Every one of those
/// sentences would be arithmetically true and would tell the reader that a
/// company which barely moved had one product carry it. A breakdown of a net
/// movement is only meaningful while the members are not busy cancelling each
/// other out, and this is where that stops being true.
pub const CONTRIBUTION_MAX_EXPLAINED: f64 = 2.0;

/// Facts kept in one bundle, matching the range path's budget.
pub const MAX_FACTS: usize = 12;

/// Below this, a residual is floating-point noise rather than an unexplained
/// remainder, and is reported as zero.
const RESIDUAL_EPSILON: f64 = 1e-9;

// ---------------------------------------------------------------------------
// What the query half hands to the pure half
// ---------------------------------------------------------------------------

/// One member of an analysis dimension, at the two periods being compared.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSeries {
    pub member: String,
    pub first: Option<f64>,
    pub last: Option<f64>,
}

impl MemberSeries {
    pub fn new(member: &str, first: f64, last: f64) -> Self {
        Self {
            member: member.to_string(),
            first: Some(first),
            last: Some(last),
        }
    }

    /// A member absent from one period contributes its whole presence: an
    /// absent value is a genuine ZERO of the measure there, not a hole to be
    /// skipped, or a product that launched this month would contribute nothing.
    pub fn delta(&self) -> f64 {
        self.last.unwrap_or(0.0) - self.first.unwrap_or(0.0)
    }
}

/// One analysis dimension's members over the compared periods.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionSlice {
    pub dimension: QualifiedColumn,
    pub members: Vec<MemberSeries>,
}

/// One term of a definitional decomposition, already measured.
///
/// `coefficient` is the sign the term carries INTO the parent (`-1` for the
/// subtrahend of a difference), so `effect = coefficient * (last - first)` and
/// the parent's own movement is the sum of the effects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverTerm {
    pub measure: String,
    pub coefficient: f64,
    pub first: f64,
    pub last: f64,
}

/// The definitional shape the planner found in a measure's AST, with the
/// operands already measured over the compared periods.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DriverInput {
    /// A `+`/`-` chain of measure references.
    Sum { terms: Vec<DriverTerm> },
    /// `numerator / denominator`, both measure references.
    Ratio {
        numerator: String,
        denominator: String,
        n_first: f64,
        n_last: f64,
        d_first: f64,
        d_last: f64,
    },
}

/// One KPI status band, as the model declares it: a floor on the value/target
/// ratio and the status at or above it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBand {
    pub threshold: f64,
    pub status: String,
}

/// Everything one measure's queries produced. The pure half takes only this.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureObservation {
    pub measure: String,
    /// The model's own display format, carried through to the report sheet.
    pub format_string: Option<String>,
    /// Period labels, oldest first.
    pub labels: Vec<String>,
    /// Values aligned with `labels`.
    pub values: Vec<f64>,
    /// The resolved target as a NUMBER, once a measure-valued target has been
    /// queried. `None` means there is no target to compare against.
    pub target_value: Option<f64>,
    pub bands: Vec<StatusBand>,
    pub slices: Vec<DimensionSlice>,
    pub driver: Option<DriverInput>,
}

impl MeasureObservation {
    fn last_two(&self) -> Option<(String, f64, String, f64)> {
        let n = self.values.len();
        if n < 2 {
            return None;
        }
        Some((
            self.labels
                .get(n - 2)
                .cloned()
                .unwrap_or_else(|| (n - 1).to_string()),
            self.values[n - 2],
            self.labels
                .get(n - 1)
                .cloned()
                .unwrap_or_else(|| n.to_string()),
            self.values[n - 1],
        ))
    }
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

/// Whether a movement is good news. `None` on a fact means NOT KNOWN, and is
/// the shape a suppressed direction produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Favourability {
    Better,
    Worse,
    /// The measure declares that movement carries no favourability at all
    /// (headcount, a mix share), or the movement is exactly zero.
    Neutral,
}

impl Favourability {
    fn word(self) -> &'static str {
        match self {
            Favourability::Better => "better",
            Favourability::Worse => "worse",
            Favourability::Neutral => "neither better nor worse",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverPart {
    pub label: String,
    /// The operand's OWN movement, when the part is one measure.
    pub movement: Option<f64>,
    /// What that contributed to the parent's movement.
    pub effect: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DecompositionKind {
    Difference,
    Ratio,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberContribution {
    pub member: String,
    pub first: f64,
    pub last: f64,
    pub delta: f64,
    /// Share of the parent's total movement. `None` whenever a share would be
    /// arithmetic nonsense — see `contributions_for`.
    pub share: Option<f64>,
}

/// A fact about a measure, as NUMBERS. Prose is built from it in `narrate_fact`
/// and never stored inside it, for the same reason `core/insights` keeps them
/// apart: a Swedish narrator and a model-written paragraph are both consumers
/// of the numbers, and a fact carrying its own sentence would make one of them
/// the source of truth for the others.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "fact", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ModelFactKind {
    Change {
        measure: String,
        first_label: String,
        last_label: String,
        first: f64,
        last: f64,
        delta: f64,
        pct: Option<f64>,
        favourability: Option<Favourability>,
        /// Where the LANDED value sits relative to the band that judged it, and
        /// the band itself. `None` under every direction but `targetBand`.
        ///
        /// Without it the sentence for a band measure says "which is worse" and
        /// stops, and the reader has to open the strategy document to learn
        /// whether the number was too high or too low - the one thing they need
        /// in order to do anything about it. The band was already computed to
        /// decide `favourability`; this keeps the side it threw away.
        band: Option<BandPlacement>,
    },
    Variance {
        measure: String,
        period_label: String,
        value: f64,
        target: f64,
        delta: f64,
        pct: Option<f64>,
        /// The KPI band the value/target ratio falls in, when the model bands it.
        ///
        /// A DIFFERENT CONCEPT FROM `band` below, and they must not be conflated:
        /// this is the model KPI's own status scale (`onTrack`/`atRisk`), read
        /// off `value / target`, while `band` is the strategy document's
        /// `Target::Band` read off the value itself.
        status: Option<String>,
        favourability: Option<Favourability>,
        /// Where the value sits relative to the strategy's `targetBand`.
        band: Option<BandPlacement>,
    },
    DefinitionalDriver {
        measure: String,
        kind: DecompositionKind,
        total_delta: f64,
        parts: Vec<DriverPart>,
        /// The part of the movement the decomposition does NOT explain. Always
        /// carried, never rounded away: a decomposition that hides its residual
        /// is a decomposition that lies.
        residual: f64,
    },
    Contribution {
        measure: String,
        dimension: String,
        total_delta: f64,
        members: Vec<MemberContribution>,
        others: Option<MemberContribution>,
        /// How much of the total movement the named members account for.
        explained: f64,
    },
    /// The non-additive substitute for `Contribution`: what the measure DID in
    /// one member, with no claim about how much of anything it accounts for.
    MemberMove {
        measure: String,
        dimension: String,
        member: String,
        first: f64,
        last: f64,
        delta: f64,
    },
    /// A fact `core/insights` produced over the measure's own series.
    ///
    /// NESTED, not flattened. `FactKind` is internally tagged on `fact` and so
    /// is this enum; flattening one into the other would emit that key twice
    /// and `facts_json` would carry a duplicate the reader silently loses.
    Series { inner: FactKind },
}

impl ModelFactKind {
    /// The bucket a `suppress` entry in the strategy document names, and the
    /// `kind` string the pane groups by.
    pub fn kind_key(&self) -> String {
        match self {
            ModelFactKind::Change { .. } => "change".to_string(),
            ModelFactKind::Variance { .. } => "variance".to_string(),
            ModelFactKind::DefinitionalDriver { .. } => "definitionalDriver".to_string(),
            ModelFactKind::Contribution { .. } => "contribution".to_string(),
            ModelFactKind::MemberMove { .. } => "memberMove".to_string(),
            ModelFactKind::Series { inner } => inner.kind_key().to_string(),
        }
    }

    /// The `suppress` entry that withholds this fact, when one can.
    ///
    /// TYPED, and asked as an exhaustive match on the model's own variants. A
    /// `Series` fact arrives as one of `core/insights`' twenty `FactKind`s and
    /// only three of those are ever wrapped by a run, so the honest answer there
    /// is "look the key up and say `None` if the vocabulary has no word for it"
    /// - not a second hand-written list of three, which is exactly the drift
    /// `every_fact_kind_a_run_can_emit_is_spelled_in_the_suppressible_list`
    /// exists to catch.
    pub fn suppressible_kind(&self) -> Option<SuppressibleFactKind> {
        match self {
            ModelFactKind::Change { .. } => Some(SuppressibleFactKind::Change),
            ModelFactKind::Variance { .. } => Some(SuppressibleFactKind::Variance),
            ModelFactKind::DefinitionalDriver { .. } => {
                Some(SuppressibleFactKind::DefinitionalDriver)
            }
            ModelFactKind::Contribution { .. } => Some(SuppressibleFactKind::Contribution),
            ModelFactKind::MemberMove { .. } => Some(SuppressibleFactKind::MemberMove),
            ModelFactKind::Series { inner } => SuppressibleFactKind::from_wire(inner.kind_key()),
        }
    }

    /// Deterministic identity. Two runs over the same numbers produce the same
    /// id for the same finding, which is what makes the bundle byte-identical.
    pub fn id(&self) -> String {
        match self {
            ModelFactKind::Change { measure, .. } => format!("change:m/{}", measure),
            ModelFactKind::Variance { measure, .. } => format!("variance:m/{}", measure),
            ModelFactKind::DefinitionalDriver { measure, .. } => {
                format!("definitionalDriver:m/{}", measure)
            }
            ModelFactKind::Contribution {
                measure, dimension, ..
            } => format!("contribution:m/{}:{}", measure, dimension),
            ModelFactKind::MemberMove {
                measure,
                dimension,
                member,
                ..
            } => format!("memberMove:m/{}:{}:{}", measure, dimension, member),
            ModelFactKind::Series { inner } => inner.id(),
        }
    }

    /// The measure every model fact is about.
    pub fn measure(&self) -> String {
        match self {
            ModelFactKind::Change { measure, .. }
            | ModelFactKind::Variance { measure, .. }
            | ModelFactKind::DefinitionalDriver { measure, .. }
            | ModelFactKind::Contribution { measure, .. }
            | ModelFactKind::MemberMove { measure, .. } => measure.clone(),
            ModelFactKind::Series { inner } => match inner.fingerprint().0.first() {
                Some(Subject::Measure { name }) => name.clone(),
                Some(Subject::Column { name, .. }) => name.clone(),
                None => String::new(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFact {
    pub id: String,
    pub kind: ModelFactKind,
    pub score: f64,
    pub text: String,
    pub evidence: Vec<WireEvidence>,
    pub provenance: Vec<AppliedAttr>,
}

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

/// The strategy layer and `core/insights` each carry an `AttrSource` with the
/// same five variants. Mapping rather than re-spelling keeps ONE place that
/// knows how a source is written on the wire (`wire::attr_source_id`).
pub fn core_source(source: &AttrSource) -> CoreAttrSource {
    match source {
        AttrSource::Base => CoreAttrSource::Base,
        AttrSource::Inferred => CoreAttrSource::Inferred,
        AttrSource::Kpi(name) => CoreAttrSource::Kpi(name.clone()),
        AttrSource::Strategy => CoreAttrSource::Strategy,
        AttrSource::Rule(id) => CoreAttrSource::Rule(id.clone()),
    }
}

fn attr(name: &str, value: String, source: &AttrSource) -> AppliedAttr {
    AppliedAttr {
        attr: name.to_string(),
        value,
        source: core_source(source),
    }
}

fn direction_word(direction: Direction) -> &'static str {
    match direction {
        Direction::HigherIsBetter => "higherIsBetter",
        Direction::LowerIsBetter => "lowerIsBetter",
        Direction::TargetBand => "targetBand",
        Direction::Neutral => "neutral",
    }
}

fn materiality_word(m: &Materiality) -> String {
    match m {
        Materiality::Absolute { value } => format!("absolute {}", value),
        Materiality::Relative { value } => format!("relative {}", value),
    }
}

fn target_word(t: &Target) -> String {
    match t {
        Target::Literal { value } => format!("literal {}", value),
        Target::Measure { r#ref } => format!("measure {}", r#ref),
        // Interval notation, so an EXCLUDED end is visible in the provenance a
        // reader is given: `band [0, 1)` and `band [0, 1]` disagree about a
        // value of exactly 1, and the reader asking "why is this unfavourable"
        // is asking about precisely that.
        Target::Band { .. } => match t.as_band() {
            Some(band) => format!("band {}", band.label()),
            None => "band".to_string(),
        },
        Target::Kpi => "kpi".to_string(),
    }
}

fn additivity_word(a: Additivity) -> &'static str {
    match a {
        Additivity::Additive => "additive",
        Additivity::NonAdditive => "nonAdditive",
        Additivity::LastValue => "lastValue",
        Additivity::FirstValue => "firstValue",
        Additivity::Average => "average",
        Additivity::Max => "max",
        Additivity::Min => "min",
    }
}

/// Direction, as an attribute the reader can go and look up — INCLUDING the
/// withheld case, which is the one they will actually ask about.
fn direction_provenance(resolved: &ResolvedMeasure) -> Vec<AppliedAttr> {
    if let Some(s) = resolved.suppression_of(Attribute::Direction) {
        return vec![AppliedAttr {
            attr: "direction".to_string(),
            value: format!("withheld: {}", s.reason),
            source: CoreAttrSource::Rule(s.rule.clone()),
        }];
    }
    match &resolved.direction {
        Some(d) => vec![attr(
            "direction",
            direction_word(d.value).to_string(),
            &d.source,
        )],
        None => Vec::new(),
    }
}

/// What a fact about a PLOTTED series of this measure may carry: the direction
/// (or its withholding) and the materiality floor, when one is declared.
///
/// The chart route (`series_strategy.rs`) attaches this to `core/insights`
/// facts computed over a chart's own categories. Additivity and target are
/// deliberately absent: a series fact makes no share claim and no variance
/// claim, so an attribute that decided nothing would be provenance for
/// nothing.
pub(crate) fn series_provenance(resolved: &ResolvedMeasure) -> Vec<AppliedAttr> {
    let mut out = direction_provenance(resolved);
    if let Some(m) = resolved.materiality.as_ref() {
        out.push(attr("materiality", materiality_word(&m.value), &m.source));
    }
    out
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/// Does this movement clear the floor the business set?
///
/// An absent materiality means nothing was declared, so nothing is filtered:
/// refusing every fact because a consultant has not written a threshold yet
/// would make an un-annotated model silently produce no insights at all.
pub fn clears_materiality(materiality: Option<&Materiality>, first: f64, delta: f64) -> bool {
    match materiality {
        None => delta != 0.0,
        Some(Materiality::Absolute { value }) => delta.abs() >= value.abs(),
        Some(Materiality::Relative { value }) => {
            if first == 0.0 {
                // A fraction of nothing is not a threshold. Any real movement
                // off a zero base is material; the alternative is suppressing
                // the launch of a product because 2% of 0 is 0.
                delta != 0.0
            } else {
                delta.abs() >= (value * first).abs()
            }
        }
    }
}

/// Which way is good, applied to a movement.
///
/// `TargetBand` answers `None` HERE and is decided one level up: "good means
/// inside a band" cannot be read off a delta, only off where the value LANDED,
/// and this function is handed only the delta.
///
/// THE HEADER THAT USED TO SIT HERE WAS WRONG IN BOTH HALVES, and it is worth
/// naming them because each sends a reader somewhere that does not exist. It
/// said a Change fact under a band carries no favourability: `facts_for_measure`
/// calls `favourability_at`, which resolves `TargetBand` through
/// `band_placement`, so a Change fact under a band carries `Better` or `Worse`
/// like any other. And it said "the variance fact answers instead": a
/// `Target::Band` never yields a `target_value` - `model_commands.rs` resolves a
/// band and a KPI target to `None` - so NO Variance fact is ever built under a
/// band and there was never a second fact to answer.
pub fn favourability_of(direction: Direction, delta: f64) -> Option<Favourability> {
    if delta == 0.0 {
        return Some(Favourability::Neutral);
    }
    match direction {
        Direction::HigherIsBetter => Some(if delta > 0.0 {
            Favourability::Better
        } else {
            Favourability::Worse
        }),
        Direction::LowerIsBetter => Some(if delta < 0.0 {
            Favourability::Better
        } else {
            Favourability::Worse
        }),
        Direction::Neutral => Some(Favourability::Neutral),
        Direction::TargetBand => None,
    }
}

/// Favourability of a movement under the measure's resolved direction, or
/// `None` when the direction is unknown or WITHHELD.
///
/// The withheld case is the whole of Rule 4 arriving at a sentence: the numbers
/// still ship, the judgement does not.
pub fn resolved_favourability(resolved: &ResolvedMeasure, delta: f64) -> Option<Favourability> {
    if resolved.suppression_of(Attribute::Direction).is_some() {
        return None;
    }
    resolved
        .direction
        .as_ref()
        .and_then(|d| favourability_of(d.value, delta))
}

/// Favourability WHERE THE VALUE LANDED, which is the only question a
/// `targetBand` direction can answer.
///
/// THE BAND HAD NO PRODUCTIVE CONSUMER AT ALL until this function existed.
/// `favourability_of` reads a delta and correctly declines the band, and nothing
/// else looked at one: a band target resolves to no `target_value`, so no
/// variance fact is ever built under it and the band decided nothing anywhere in
/// a shipped run. A caller that HAS the landed value (every fact below does) can
/// decide it here, and the bounds' inclusivity is spent on exactly this call.
///
/// Everything else falls through to the delta reading, unchanged.
pub fn favourability_at(
    resolved: &ResolvedMeasure,
    value: Option<f64>,
    delta: f64,
) -> Option<Favourability> {
    if resolved.suppression_of(Attribute::Direction).is_some() {
        return None;
    }
    let is_band = resolved.direction.as_ref().map(|d| d.value) == Some(Direction::TargetBand);
    if is_band {
        // ONE band predicate for the whole file: `side` answers inside/below/
        // above and `contains` is the inside half of it, so the inclusivity
        // flags cannot be read one way here and another way in the sentence.
        return band_placement(resolved, value).map(|p| match p.side {
            BandSide::Inside => Favourability::Better,
            BandSide::Below | BandSide::Above => Favourability::Worse,
        });
    }
    resolved_favourability(resolved, delta)
}

/// Where a landed value sits relative to the band that judges it.
///
/// `None` unless the measure really resolves to `targetBand` here, a band is
/// actually declared at this point, the direction is not suppressed, and the
/// caller has a value - which is exactly the set of conditions under which the
/// band decides anything at all.
pub fn band_placement(resolved: &ResolvedMeasure, value: Option<f64>) -> Option<BandPlacement> {
    if resolved.suppression_of(Attribute::Direction).is_some() {
        return None;
    }
    if resolved.direction.as_ref().map(|d| d.value) != Some(Direction::TargetBand) {
        return None;
    }
    let bounds = resolved.target.as_ref().and_then(|t| t.value.as_band())?;
    let v = value?;
    Some(BandPlacement {
        side: bounds.side(v),
        bounds,
    })
}

/// The additivity that actually applies along `dimension`, and whether the
/// document said so ABOUT THAT DIMENSION or merely by default.
///
/// The three spellings are the contract `validate_aggregation` blesses -
/// `Table[Column]`, the bare column, the bare table - and they were tried in ONE
/// place and not the other: the share gate looked for all three while the
/// provenance line looked only for `Table[Column]`, so a `byDimension` keyed on
/// `"Date"` denied the share and then printed the default as the reason. Both
/// now ask the same question through this function.
pub fn effective_additivity(
    spec: &AggregationSpec,
    dimension: &QualifiedColumn,
) -> (Additivity, bool) {
    let per_dimension = spec
        .by_dimension
        .get(&dimension.to_string())
        .or_else(|| spec.by_dimension.get(&dimension.column))
        .or_else(|| spec.by_dimension.get(&dimension.table))
        .copied();
    match per_dimension {
        Some(a) => (a, true),
        None => (spec.default, false),
    }
}

/// Is this measure summable along `dimension`?
///
/// The per-dimension entry wins over the default, which is what makes a stock
/// balance additive over Product and `lastValue` over Date. Anything that is
/// not `Additive` forfeits the share claim.
pub fn is_additive_over(resolved: &ResolvedMeasure, dimension: &QualifiedColumn) -> bool {
    let Some(agg) = resolved.aggregation.as_ref() else {
        // Nothing declared and no model default reached us: refuse the share
        // rather than assume the convenient answer.
        return false;
    };
    effective_additivity(&agg.value, dimension).0 == Additivity::Additive
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Decomposition {
    pub kind: DecompositionKind,
    pub parts: Vec<DriverPart>,
    pub residual: f64,
}

fn snap(value: f64, scale: f64) -> f64 {
    if value.abs() <= RESIDUAL_EPSILON * scale.abs().max(1.0) {
        0.0
    } else {
        value
    }
}

/// Attribute a difference EXACTLY.
///
/// `Margin = Revenue - Cost` and the deltas add up to the parent's delta by
/// construction, so the residual here is floating-point noise and nothing else.
/// It is still computed and still reported, because the day someone hands this
/// a term list that does not match the parent's own movement, the residual is
/// the only thing that will say so.
pub fn additive_decomposition(total_delta: f64, terms: &[DriverTerm]) -> Decomposition {
    let mut parts = Vec::with_capacity(terms.len());
    let mut explained = 0.0;
    for term in terms {
        let movement = term.last - term.first;
        let effect = term.coefficient * movement;
        explained += effect;
        parts.push(DriverPart {
            label: term.measure.clone(),
            movement: Some(movement),
            effect,
        });
    }
    Decomposition {
        kind: DecompositionKind::Difference,
        parts,
        residual: snap(total_delta - explained, total_delta),
    }
}

/// First-order attribution of a ratio's movement, with the remainder STATED.
///
/// `M = N/D`. Expanding about `(N0, D0)` and keeping the first-order terms:
///
///   numerator effect   =  dN / D0
///   denominator effect = -N0 * dD / D0^2
///   interaction        = -dN * dD / D0^2
///
/// The three do NOT sum to the true movement — the expansion drops terms in
/// `dD^2` — and the difference is the residual. An exact two-term split exists
/// (`dN/D1 - N0*dD/(D0*D1)`) and was rejected: it is order-dependent, so
/// attributing to the numerator first and to the denominator first give
/// different answers, and neither is more true than the other. A first-order
/// split is symmetric, and it is honest precisely because it admits what it
/// left over.
pub fn ratio_decomposition(
    numerator: &str,
    denominator: &str,
    n_first: f64,
    n_last: f64,
    d_first: f64,
    d_last: f64,
) -> Option<Decomposition> {
    if d_first == 0.0 || d_last == 0.0 {
        // A ratio with a zero denominator at either end has no movement to
        // decompose, and dividing by it would fabricate an infinity.
        return None;
    }
    let dn = n_last - n_first;
    let dd = d_last - d_first;
    let total_delta = n_last / d_last - n_first / d_first;

    let num_effect = dn / d_first;
    let den_effect = -n_first * dd / (d_first * d_first);
    let interaction = -dn * dd / (d_first * d_first);

    let parts = vec![
        DriverPart {
            label: numerator.to_string(),
            movement: Some(dn),
            effect: num_effect,
        },
        DriverPart {
            label: denominator.to_string(),
            movement: Some(dd),
            effect: den_effect,
        },
        DriverPart {
            label: "interaction".to_string(),
            movement: None,
            effect: interaction,
        },
    ];
    let residual = total_delta - (num_effect + den_effect + interaction);
    Some(Decomposition {
        kind: DecompositionKind::Ratio,
        parts,
        residual: snap(residual, total_delta),
    })
}

/// Build the decomposition a measured `DriverInput` supports.
pub fn decomposition_for(total_delta: f64, input: &DriverInput) -> Option<Decomposition> {
    match input {
        DriverInput::Sum { terms } if !terms.is_empty() => {
            Some(additive_decomposition(total_delta, terms))
        }
        DriverInput::Sum { .. } => None,
        DriverInput::Ratio {
            numerator,
            denominator,
            n_first,
            n_last,
            d_first,
            d_last,
        } => ratio_decomposition(
            numerator,
            denominator,
            *n_first,
            *n_last,
            *d_first,
            *d_last,
        ),
    }
}

// ---------------------------------------------------------------------------
// Contribution
// ---------------------------------------------------------------------------

/// Rank members by how much they moved, most first.
///
/// The tie-break is the member NAME, ascending. Without it two members that
/// moved by the same amount would order by whatever the query returned, and the
/// bundle would stop being byte-identical between runs.
fn ranked(members: &[MemberSeries]) -> Vec<&MemberSeries> {
    let mut out: Vec<&MemberSeries> = members.iter().collect();
    out.sort_by(|a, b| {
        b.delta()
            .abs()
            .partial_cmp(&a.delta().abs())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.member.cmp(&b.member))
    });
    out
}

/// The facts a dimension's members support for this measure.
///
/// THE MOST IMPORTANT GATE IN THIS FILE. When the measure is additive over the
/// dimension, the members' movements sum to the measure's movement and a SHARE
/// of that total is a real number. When it is not — a ratio, an average, a
/// closing balance — the members' movements sum to nothing in particular, and a
/// share of the total is arithmetic nonsense stated with confidence. The
/// non-additive branch therefore returns MOVEMENTS, one per member, each saying
/// only what the measure did there.
pub fn contributions_for(
    measure: &str,
    slice: &DimensionSlice,
    additive: bool,
) -> Vec<ModelFactKind> {
    let dimension = slice.dimension.to_string();
    let order = ranked(&slice.members);
    if order.is_empty() {
        return Vec::new();
    }

    if !additive {
        return order
            .into_iter()
            .take(CONTRIBUTION_TOP_N)
            .filter(|m| m.delta() != 0.0)
            .map(|m| ModelFactKind::MemberMove {
                measure: measure.to_string(),
                dimension: dimension.clone(),
                member: m.member.clone(),
                first: m.first.unwrap_or(0.0),
                last: m.last.unwrap_or(0.0),
                delta: m.delta(),
            })
            .collect();
    }

    let total_delta: f64 = slice.members.iter().map(MemberSeries::delta).sum();
    if total_delta == 0.0 {
        // Members that moved in both directions and cancelled. A share of zero
        // is undefined, and "Gadgets accounts for 400% of a movement of zero"
        // is the sentence this refusal exists to prevent.
        return Vec::new();
    }

    let named: Vec<&MemberSeries> = order.iter().copied().take(CONTRIBUTION_TOP_N).collect();
    let named_delta: f64 = named.iter().map(|m| m.delta()).sum();
    let explained = named_delta / total_delta;
    if !(CONTRIBUTION_MIN_EXPLAINED..=CONTRIBUTION_MAX_EXPLAINED).contains(&explained) {
        // Below the floor the movement lives in the tail and naming five
        // members points the reader at the wrong place; above the ceiling the
        // members are cancelling each other and the "total" they are shares of
        // is noise. Both are refusals, and neither is a caveat.
        return Vec::new();
    }

    let members: Vec<MemberContribution> = named
        .iter()
        .map(|m| MemberContribution {
            member: m.member.clone(),
            first: m.first.unwrap_or(0.0),
            last: m.last.unwrap_or(0.0),
            delta: m.delta(),
            share: Some(m.delta() / total_delta),
        })
        .collect();

    let rest: Vec<&MemberSeries> = order.into_iter().skip(CONTRIBUTION_TOP_N).collect();
    let others = if rest.is_empty() {
        None
    } else {
        let delta: f64 = rest.iter().map(|m| m.delta()).sum();
        Some(MemberContribution {
            member: format!("everything else ({})", rest.len()),
            first: rest.iter().map(|m| m.first.unwrap_or(0.0)).sum(),
            last: rest.iter().map(|m| m.last.unwrap_or(0.0)).sum(),
            delta,
            share: Some(delta / total_delta),
        })
    };

    vec![ModelFactKind::Contribution {
        measure: measure.to_string(),
        dimension,
        total_delta,
        members,
        others,
        explained,
    }]
}

// ---------------------------------------------------------------------------
// Planning: which measures, which axis, which dimensions
// ---------------------------------------------------------------------------

/// Measures to analyse, in the order the business ranks them.
///
/// An explicit request wins outright — the caller asked about those measures
/// and substituting others would answer a different question. Otherwise:
/// `model.priority` in its declared order, then measures carrying a KPI, then
/// the rest, each group sorted by name so the choice never depends on map
/// iteration order.
pub fn choose_measures(
    doc: &StrategyDoc,
    facts: &ModelFacts,
    requested: &[String],
) -> Vec<String> {
    let mut chosen: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let push = |name: &str, chosen: &mut Vec<String>, seen: &mut BTreeSet<String>| {
        if facts.measures.contains_key(name) && seen.insert(name.to_string()) {
            chosen.push(name.to_string());
        }
    };

    if !requested.is_empty() {
        for name in requested {
            push(name, &mut chosen, &mut seen);
        }
        chosen.truncate(MAX_MEASURES_PER_RUN);
        return chosen;
    }

    for name in &doc.model.priority {
        push(name, &mut chosen, &mut seen);
    }
    // `facts.measures` is a BTreeMap, so both remaining groups are already in
    // name order.
    for (name, m) in &facts.measures {
        if m.kpi.is_some() {
            push(name, &mut chosen, &mut seen);
        }
    }
    for name in facts.measures.keys() {
        push(name, &mut chosen, &mut seen);
    }
    chosen.truncate(MAX_MEASURES_PER_RUN);
    chosen
}

/// What came of choosing a time axis: the column, and what had to be said aloud
/// about how it was chosen.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TimeAxisPlan {
    pub axis: Option<QualifiedColumn>,
    pub notes: Vec<String>,
}

/// The column the analysis walks time along, and the note that choice owes the
/// reader.
///
/// `defaultTimeAxis` wins when the model really has that column. Otherwise the
/// date table's own date column. When neither exists there is NO time axis, and
/// the caller must say so in `notes` rather than ordering the rows by whatever
/// came back and calling the result a trend.
///
/// A GUESSED CALENDAR IS ANNOUNCED, and that is the reason this returns a plan
/// rather than a column. `facts.rs` infers a date table on a model whose author
/// never marked one — an ordinary imported star schema — which is what makes
/// trend, seasonality and change-point facts possible there at all. But every
/// one of those facts is then computed against an axis NOBODY DECLARED, and a
/// guess that drives the whole time half of a report while looking exactly like
/// a declaration is the same failure `plan_dimensions` pushes its empty-
/// dimensions note to prevent: honest, and invisible. So the axis is reported
/// with its provenance whenever the calendar under it was inferred — including
/// when the axis itself came from `defaultTimeAxis`, because a drafted document
/// copies the inferred calendar's column straight into that field.
pub fn plan_time_axis(
    doc: &StrategyDoc,
    facts: &ModelFacts,
    date_columns: &[QualifiedColumn],
) -> TimeAxisPlan {
    let axis = doc
        .model
        .default_time_axis
        .as_ref()
        .filter(|declared| facts.has_column(declared))
        .cloned()
        .or_else(|| {
            let date_table = facts.date_table.as_deref()?;
            date_columns
                .iter()
                .find(|c| c.table == date_table && facts.has_column(c))
                .cloned()
        });
    let mut notes: Vec<String> = Vec::new();
    if let Some(axis) = axis.as_ref() {
        let on_the_calendar = facts.date_table.as_deref() == Some(axis.table.as_str());
        if on_the_calendar {
            match facts.calendar_source {
                Some(CalendarSource::Inferred) => notes.push(format!(
                    "Time runs along {}, and nobody said it should: no table in this model is \
                     marked as its date table, so {} was guessed to be the calendar from its \
                     column names. Every trend, change point and seasonality claim below rests on \
                     that guess. Mark the date table in the Model Editor to make it a decision.",
                    axis, axis.table
                )),
                // A CHOICE, NOT A GUESS — and still worth saying, for a reason
                // the guessed case does not have: the MODEL marks no date table,
                // so the engine's own time intelligence (TOTALYTD, DATEADD)
                // still refuses to run. A reader who sees a trend here and no
                // year-to-date measure anywhere deserves to know why.
                Some(CalendarSource::Authored) => notes.push(format!(
                    "Time runs along {}, because the strategy document says {} is the calendar. \
                     The model itself marks no date table, so this report has a time axis while \
                     the model's own time-intelligence measures do not. Mark {} as the date table \
                     in the Model Editor to give them one too.",
                    axis, axis.table, axis.table
                )),
                Some(CalendarSource::Declared) | None => {}
            }
        }
    }
    TimeAxisPlan { axis, notes }
}

/// What came of planning one measure's dimensions.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DimensionPlan {
    pub dimensions: Vec<QualifiedColumn>,
    pub notes: Vec<String>,
}

/// Choose the dimensions to slice a measure by, and REPORT everything dropped.
///
/// The reachability check is `directly_related_tables`, not `reachable_tables`,
/// because the executor refuses a path longer than one hop: a dimension two
/// joins away is not a breakdown we declined to show, it is one the engine
/// would refuse to compute. Either way the user must be told, or a section
/// simply is not there and nobody knows to ask.
pub fn plan_dimensions(
    resolved: &ResolvedMeasure,
    facts: &ModelFacts,
    fact_table: Option<&str>,
) -> DimensionPlan {
    let mut plan = DimensionPlan::default();
    let reachable = fact_table.map(|t| facts.directly_related_tables(t));

    // NO DIMENSIONS AT ALL IS THE COMMON CASE, AND IT MUST NOT BE SILENT.
    //
    // Inference deliberately leaves `analysisDimensions` empty (see
    // `INFER_ANALYSIS_DIMENSIONS` in `strategy/infer.rs`): with no column
    // statistics it cannot tell a country column from a full-name column, and a
    // wrong breakdown surfaces as a confident explanation of the wrong thing
    // rather than as a visibly wrong field. Empty is the honest answer.
    //
    // But it is only honest if somebody is TOLD. Every other way a dimension can
    // fall out of this loop pushes a note; an empty list pushed none, because
    // the loop never ran — so the measure simply had no breakdown section and
    // nothing said why. That is the "a section is not there and nobody knows to
    // ask" failure this function's own header warns about, reached through the
    // one path the header did not cover.
    if resolved.analysis_dimensions.is_empty() {
        plan.notes.push(format!(
            "{} was not broken down by anything: its strategy declares no analysis dimensions. \
             Add one in the Model Editor's Strategy tab to see where a movement came from.",
            resolved.measure
        ));
        return plan;
    }

    for dimension in &resolved.analysis_dimensions {
        if resolved.never_slice_by.contains(dimension) {
            // THE DOCUMENT CONTRADICTS ITSELF, AND THE READER WAS NOT TOLD.
            //
            // This branch used to say "a deliberate exclusion, not a failure -
            // it is named in the document the reader can open, so it needs no
            // note", and that reasoning has the report's reader confused with
            // the document's author. The person holding the report does not have
            // the strategy file open; they see a breakdown section that is
            // simply not there, which is the exact failure this function's own
            // header exists to prevent, reached through the one path the header
            // did not cover. `validate` refuses a document that says both things
            // about one column, so this is the note for the hand-edited file
            // that reached the run path anyway.
            plan.notes.push(format!(
                "{} was not sliced by {}: its strategy lists that column as an analysis \
                 dimension AND forbids slicing by it. The prohibition wins; remove one of the \
                 two statements to settle which was meant.",
                resolved.measure, dimension
            ));
            continue;
        }
        if !facts.has_column(dimension) {
            plan.notes.push(format!(
                "{} is not sliced by {}: the model has no such column.",
                resolved.measure, dimension
            ));
            continue;
        }
        match reachable.as_ref() {
            Some(tables) if !tables.contains(&dimension.table) => {
                plan.notes.push(format!(
                    "{} could not be sliced by {}: {} is not directly related to {}, and the \
                     query executor refuses a path longer than one relationship.",
                    resolved.measure,
                    dimension,
                    dimension.table,
                    fact_table.unwrap_or("the fact table")
                ));
                continue;
            }
            _ => {}
        }
        if plan.dimensions.len() >= MAX_DIMENSIONS_PER_MEASURE {
            plan.notes.push(format!(
                "{} was sliced by the first {} of its analysis dimensions; {} was not queried.",
                resolved.measure, MAX_DIMENSIONS_PER_MEASURE, dimension
            ));
            continue;
        }
        plan.dimensions.push(dimension.clone());
    }
    plan
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

fn moved(delta: f64, locale: &LocaleSettings) -> String {
    let word = if delta > 0.0 {
        "rose"
    } else if delta < 0.0 {
        "fell"
    } else {
        "held at"
    };
    format!("{} {}", word, number::num(delta.abs(), locale))
}

/// The relative-change parenthetical, when it is not a trap.
///
/// A PERCENTAGE CHANGE OF A PERCENTAGE IS THE CLASSIC MISREADING, and this is
/// what `unit` is for. A margin moving from 10% to 12% has risen by two
/// PERCENTAGE POINTS and by twenty PER CENT, and a sentence that prints
/// "rose 0.02 ... (+20.0%)" invites the reader to take the larger number as the
/// move. So for a `percent` or `ratio` measure the clause is withheld and the
/// absolute movement stands alone, which is unambiguous.
///
/// IT DELIBERATELY DOES NOT RESCALE OR APPEND A SIGN, and that limit is the
/// honest half. This layer does not know whether a percent measure is stored as
/// `0.12` or as `12` — `format_string` knows, because `0.0%` scales by a
/// hundred and `0.0"%"` does not, and `unit` carries no such thing. Anything
/// that needs the SCALE must read the format string; `unit` can only decide
/// which sentence to write.
///
/// The `_` arm is deliberate and is where Tier B plugs in (§13 of the design
/// doc): a user-defined unit must land on a wording this function chose on
/// purpose, never fall through to one it happens to reach.
fn with_pct(pct: Option<f64>, unit: Option<Unit>, locale: &LocaleSettings) -> String {
    match unit {
        Some(Unit::Percent) | Some(Unit::Ratio) => String::new(),
        _ => match pct {
            Some(p) => format!(" ({})", number::signed_pct(p, locale)),
            None => String::new(),
        },
    }
}

/// " 160,000 is above the band [90000, 140000]."
///
/// THE BAND WAS ABSENT FROM THE WHOLE OUTPUT, not just from this sentence. A
/// `targetBand` measure produces no variance fact at all (a band target maps to
/// no `target_value`), and the Change fact's provenance carried only direction
/// and materiality - so the number that decided "worse" appeared nowhere a
/// reader could see it, and "worse" alone does not say whether to ship more or
/// ship less.
fn band_clause(band: Option<BandPlacement>, value: f64, locale: &LocaleSettings) -> String {
    match band {
        Some(p) => format!(
            " {} is {} the band {}.",
            number::num(value, locale),
            p.side.word(),
            p.bounds.label()
        ),
        None => String::new(),
    }
}

/// One sentence per fact, in the reader's number formatting.
/// One fact as a sentence, in the reader's number formatting.
///
/// TAKES THE MEASURE'S UNIT, because two of them change which sentence is
/// correct rather than merely how a number is punctuated - see `with_pct`.
pub fn narrate_fact(
    kind: &ModelFactKind,
    unit: Option<Unit>,
    locale: &LocaleSettings,
) -> String {
    match kind {
        ModelFactKind::Change {
            measure,
            first_label,
            last_label,
            first,
            last,
            delta,
            pct,
            favourability,
            band,
        } => {
            let judgement = match favourability {
                Some(f) => format!(", which is {}", f.word()),
                // A withheld direction says so, rather than leaving the reader
                // to assume the number speaks for itself.
                None => ", with no favourability claim".to_string(),
            };
            format!(
                "{} {} from {} in {} to {} in {}{}{}.{}",
                measure,
                moved(*delta, locale),
                number::num(*first, locale),
                first_label,
                number::num(*last, locale),
                last_label,
                with_pct(*pct, unit, locale),
                judgement,
                band_clause(*band, *last, locale)
            )
        }
        ModelFactKind::Variance {
            measure,
            period_label,
            value,
            target,
            delta,
            pct,
            status,
            favourability,
            band,
        } => {
            // The KPI's own status scale, which is NOT the strategy band below.
            let kpi_status = match status {
                Some(s) => format!(" Status: {}.", s),
                None => String::new(),
            };
            let judgement = match favourability {
                Some(f) => format!(", which is {}", f.word()),
                None => ", with no favourability claim".to_string(),
            };
            format!(
                "{} was {} in {} against a target of {}, {} {}{}{}.{}{}",
                measure,
                number::num(*value, locale),
                period_label,
                number::num(*target, locale),
                if *delta >= 0.0 { "over by" } else { "under by" },
                number::num(delta.abs(), locale),
                with_pct(*pct, unit, locale),
                judgement,
                kpi_status,
                band_clause(*band, *value, locale)
            )
        }
        ModelFactKind::DefinitionalDriver {
            measure,
            kind,
            total_delta,
            parts,
            residual,
        } => {
            let clauses: Vec<String> = parts
                .iter()
                .map(|p| match (p.movement, kind) {
                    (Some(m), DecompositionKind::Difference) => {
                        format!("{} {}", p.label, moved(m, locale))
                    }
                    (Some(m), DecompositionKind::Ratio) => format!(
                        "{} {} and contributed {}",
                        p.label,
                        moved(m, locale),
                        number::num(p.effect, locale)
                    ),
                    (None, _) => format!(
                        "their {} contributed {}",
                        p.label,
                        number::num(p.effect, locale)
                    ),
                })
                .collect();
            format!(
                "{} {}; {} (residual {}).",
                measure,
                moved(*total_delta, locale),
                join_and(&clauses),
                number::num(*residual, locale)
            )
        }
        ModelFactKind::Contribution {
            measure,
            dimension,
            total_delta,
            members,
            others,
            explained,
        } => {
            let mut clauses: Vec<String> = members
                .iter()
                .map(|m| {
                    format!(
                        "{} {}{}",
                        m.member,
                        moved(m.delta, locale),
                        match m.share {
                            Some(s) => format!(" ({} of the total)", number::pct(s, locale)),
                            None => String::new(),
                        }
                    )
                })
                .collect();
            if let Some(o) = others {
                clauses.push(format!("{} {}", o.member, moved(o.delta, locale)));
            }
            format!(
                "{} {} across {}: {}. The named members account for {} of the movement.",
                measure,
                moved(*total_delta, locale),
                dimension,
                join_and(&clauses),
                number::pct(*explained, locale)
            )
        }
        ModelFactKind::MemberMove {
            measure,
            dimension,
            member,
            first,
            last,
            ..
        } => format!(
            "{} moved from {} to {} in {} {}. It is not additive across {}, so no share of the \
             total is claimed.",
            measure,
            number::num(*first, locale),
            number::num(*last, locale),
            dimension,
            member,
            dimension
        ),
        ModelFactKind::Series { inner } => {
            narrate::narrator_for(narrate::Locale::from_locale_id(&locale.locale_id)).narrate(inner)
        }
    }
}

fn join_and(clauses: &[String]) -> String {
    match clauses.len() {
        0 => String::new(),
        1 => clauses[0].clone(),
        _ => format!(
            "{} and {}",
            clauses[..clauses.len() - 1].join(", "),
            clauses[clauses.len() - 1]
        ),
    }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/// A weight, never a probability. Bigger relative movements and facts about
/// declared-priority measures rank higher; the arithmetic is fixed so two runs
/// order identically.
fn score_for(kind: &ModelFactKind, resolved: &ResolvedMeasure) -> f64 {
    let magnitude = |pct: Option<f64>, fallback: f64| -> f64 {
        pct.map(|p| p.abs().min(1.0)).unwrap_or(fallback)
    };
    // THE BANDS, and the one invariant between them: a movement's EXPLANATION
    // must never outrank the movement it explains. A contribution tops out at
    // 0.70 (`0.50 + 0.20 * explained`), so a change STARTS at 0.71 — a reader
    // needs "Revenue down 10%" before "Gadgets caused it". Variance keeps its
    // 0.10 lead over change, as before.
    //
    // FOUND LIVE (2026-09-18, `insight-overlays-pivot.spec.ts`): the old bands
    // were `change = 0.60 + 0.25*pct` against `contribution = 0.50 + 0.20*e`,
    // which overlap. Setting them equal gives pct = 0.40, so for ANY movement
    // under 40% a fully-explained contribution outranked its own change fact.
    // On the sales-star fixture Revenue fell 10.4%: its three breakdowns
    // scored 0.70 and its headline 0.626, `MAX_FACTS` cut the four lowest, and
    // the bundle kept the explanations of a movement it never stated.
    //
    // Priority and weight are applied per MEASURE below, so they cancel
    // between one measure's own facts and cannot reorder them. Only these
    // bands can, which is why the invariant has to live here.
    let base = match kind {
        ModelFactKind::Variance { pct, .. } => 0.81 + 0.19 * magnitude(*pct, 0.2),
        ModelFactKind::Change { pct, .. } => 0.71 + 0.19 * magnitude(*pct, 0.2),
        ModelFactKind::DefinitionalDriver { .. } => 0.58,
        ModelFactKind::Contribution { explained, .. } => 0.50 + 0.20 * explained.abs().min(1.0),
        ModelFactKind::MemberMove { .. } => 0.40,
        ModelFactKind::Series { inner } => match inner {
            FactKind::Trend { r2, .. } => 0.45 + 0.20 * r2.min(1.0),
            FactKind::ChangePoint { .. } => 0.44,
            FactKind::Seasonality { .. } => 0.35,
            _ => 0.30,
        },
    };
    let weight = resolved.rank_weight.as_ref().map(|w| w.value).unwrap_or(1.0);
    // A declared priority is 0-based: the first measure the business listed is
    // the most important one, so a LOW number must lift the score.
    let priority_bonus = match resolved.priority.as_ref() {
        Some(p) => 0.10 / (1.0 + p.value as f64),
        None => 0.0,
    };
    ((base + priority_bonus) * weight).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Fact generation for one measure
// ---------------------------------------------------------------------------

fn query_evidence(label: String, measures: Vec<String>, group_by: Vec<String>) -> WireEvidence {
    WireEvidence {
        kind: EvidenceKind::Query,
        label,
        sheet_index: None,
        start_row: None,
        start_col: None,
        end_row: None,
        end_col: None,
        measures: Some(measures),
        group_by: if group_by.is_empty() {
            None
        } else {
            Some(group_by)
        },
    }
}

fn pct_change(first: f64, last: f64) -> Option<f64> {
    if first == 0.0 {
        None
    } else {
        Some((last - first) / first.abs())
    }
}

/// The KPI band a value/target ratio falls in.
///
/// Bands are declared as FLOORS, so the answer is the highest threshold at or
/// below the ratio. Sorting a copy rather than trusting the declaration order
/// is what stops a model that lists its bands high-to-low from reporting
/// "OnTrack" for a value at 10% of target.
fn band_for(bands: &[StatusBand], ratio: f64) -> Option<String> {
    let mut sorted: Vec<&StatusBand> = bands.iter().collect();
    sorted.sort_by(|a, b| {
        a.threshold
            .partial_cmp(&b.threshold)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    sorted
        .into_iter()
        .filter(|b| ratio >= b.threshold)
        .next_back()
        .map(|b| b.status.clone())
}

/// What one measure's run produced, in the shape the report sheet needs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureRun {
    pub measure: String,
    pub format_string: Option<String>,
    pub period_label: String,
    pub value: Option<f64>,
    pub prior_label: String,
    pub prior_value: Option<f64>,
    pub delta: Option<f64>,
    pub pct: Option<f64>,
    pub target: Option<f64>,
    pub status: Option<String>,
    pub favourability: Option<Favourability>,
    /// The best decomposition, as one line. `None` when the measure's own
    /// definition is not a difference or a ratio of measures.
    pub driver: Option<String>,
    pub priority: Option<u32>,
}

/// Every `core/insights` series builder a run applies, as DATA rather than as
/// three inline calls.
///
/// WHY A LIST. A `Series` fact reaches a `suppress` entry only if
/// `SuppressibleFactKind::from_wire` has a word for its `kind_key`;
/// `suppressible_kind` answers `None` when it does not, and the filter in
/// `facts_for_measure` uses `is_some_and`, so an unnamed kind is silently
/// UNSUPPRESSIBLE - a consultant writes the `suppress` entry, the validator
/// accepts it, and the fact appears in the report anyway. The test that diffs
/// the emitted kinds against the vocabulary hand-typed the same three builders
/// this function called inline, so a fourth call escaped the diff entirely: two
/// lists, one of them a copy, and the copy is the one the guard read.
///
/// The test now builds its samples by RUNNING this list, so a fourth builder is
/// inside the diff from the moment it is added here. The name is carried only so
/// that test can say which builder produced nothing on its probes.
const SERIES_BUILDERS: &[(&str, fn(&timeseries::Series, Option<usize>) -> Vec<FactKind>)] = &[
    ("trend", |s, _| timeseries::trend_fact(s).into_iter().collect()),
    ("change points", |s, _| timeseries::change_point_facts(s)),
    // The only builder that takes the cycle. The other two are handed it and
    // ignore it, which keeps ONE signature for the table rather than a special
    // case that a fourth builder would have to guess at.
    ("seasonality", |s, cycle| {
        timeseries::seasonality_fact(s, cycle).into_iter().collect()
    }),
];

/// Every fact one measure supports, plus its row of the report.
pub fn facts_for_measure(
    observation: &MeasureObservation,
    resolved: &ResolvedMeasure,
    locale: &LocaleSettings,
) -> (Vec<ModelFact>, MeasureRun) {
    let mut kinds: Vec<(ModelFactKind, Vec<AppliedAttr>, Vec<WireEvidence>)> = Vec::new();
    let measure = observation.measure.clone();
    let series_evidence = query_evidence(
        format!("{} over the period", measure),
        vec![measure.clone()],
        Vec::new(),
    );

    let mut run = MeasureRun {
        measure: measure.clone(),
        format_string: observation.format_string.clone(),
        priority: resolved.priority.as_ref().map(|p| p.value),
        ..MeasureRun::default()
    };

    // A single period is not a comparison, but it IS a value: the report row
    // and any variance against target still need it, so it is filled in before
    // the two-period gate rather than inside it.
    if let Some(last) = observation.values.last() {
        run.value = Some(*last);
        run.period_label = observation
            .labels
            .last()
            .cloned()
            .unwrap_or_else(|| "the period".to_string());
    }

    // --- Change -------------------------------------------------------------
    if let Some((first_label, first, last_label, last)) = observation.last_two() {
        let delta = last - first;
        let pct = pct_change(first, last);
        run.period_label = last_label.clone();
        run.value = Some(last);
        run.prior_label = first_label.clone();
        run.prior_value = Some(first);
        run.delta = Some(delta);
        run.pct = pct;

        let materiality = resolved.materiality.as_ref().map(|m| &m.value);
        if clears_materiality(materiality, first, delta) {
            // The landed value, not just the movement: under a `targetBand`
            // direction that is the only thing that can be judged, and it is
            // what makes a declared band decide something in a shipped run.
            let favourability = favourability_at(resolved, Some(last), delta);
            let band = band_placement(resolved, Some(last));
            run.favourability = favourability;
            let mut provenance = direction_provenance(resolved);
            if let Some(m) = resolved.materiality.as_ref() {
                provenance.push(attr(
                    "materiality",
                    materiality_word(&m.value),
                    &m.source,
                ));
            }
            // THE BAND IS PART OF THE ANSWER, so it belongs in the answer's
            // provenance. A Change fact never carried its target because a
            // change is about a movement - but under `targetBand` the band is
            // precisely what decided "better" or "worse", and the why-panel was
            // showing the direction that used it and never the band itself.
            if band.is_some() {
                if let Some(t) = resolved.target.as_ref() {
                    provenance.push(attr("target", target_word(&t.value), &t.source));
                }
            }
            kinds.push((
                ModelFactKind::Change {
                    measure: measure.clone(),
                    first_label,
                    last_label,
                    first,
                    last,
                    delta,
                    pct,
                    favourability,
                    band,
                },
                provenance,
                vec![series_evidence.clone()],
            ));
        }
    }

    // --- Variance against the resolved target -------------------------------
    //
    // IT DOES NOT TOUCH `run.favourability`, AND THAT IS THE ROW/SENTENCE SPLIT
    // A READER TRIPS OVER. `run.favourability` is written in the Change branch
    // above and nowhere else, so on a point whose MOVEMENT is below the
    // materiality floor while its LEVEL is judged against a target, the report
    // ROW's Status cell reads "No claim" (what `favourability_word` in
    // report.rs answers for `None`, unless a KPI band fills the cell instead
    // - and NOT written here as a call, because a bare name before a bracket
    // in a body this reachable is what `called_names` in
    // `document_store_census_tests` mistakes for an edge) while the variance
    // SENTENCE right next to it calls the measure better or worse in so many
    // words. The shipped fixture has exactly such a point - the last inline test
    // in `tests/fixtures/model/sales_star_strategy.json`, Revenue moving 5000
    // against a floor of 15000 and sitting 95000 under a target of 1.5M.
    //
    // Neither half is a bug: the row summarises the MOVEMENT and the fact list
    // carries every judgement. It is written down because "the report says
    // nothing here" has been inferred from the row three times, and each time it
    // produced a harness that scored a judged point as silent.
    if let (Some(target), Some(value)) = (observation.target_value, run.value) {
        if target != 0.0 {
            let delta = value - target;
            let status = band_for(&observation.bands, value / target);
            run.target = Some(target);
            run.status = status.clone();
            let mut provenance = direction_provenance(resolved);
            if let Some(t) = resolved.target.as_ref() {
                provenance.push(attr("target", target_word(&t.value), &t.source));
            }
            kinds.push((
                ModelFactKind::Variance {
                    measure: measure.clone(),
                    period_label: run.period_label.clone(),
                    value,
                    target,
                    delta,
                    pct: pct_change(target, value),
                    status,
                    favourability: favourability_at(resolved, Some(value), delta),
                    band: band_placement(resolved, Some(value)),
                },
                provenance,
                vec![series_evidence.clone()],
            ));
        }
    }

    // --- Definitional driver ------------------------------------------------
    if let (Some(input), Some(total_delta)) = (observation.driver.as_ref(), run.delta) {
        if let Some(decomposition) = decomposition_for(total_delta, input) {
            let operands: Vec<String> = decomposition
                .parts
                .iter()
                .filter(|p| p.movement.is_some())
                .map(|p| p.label.clone())
                .collect();
            let mut measures = vec![measure.clone()];
            measures.extend(operands.iter().cloned());
            let kind = ModelFactKind::DefinitionalDriver {
                measure: measure.clone(),
                kind: decomposition.kind,
                total_delta,
                parts: decomposition.parts,
                residual: decomposition.residual,
            };
            run.driver = Some(narrate_fact(&kind, resolved.unit.as_ref().map(|u| u.value), locale));
            kinds.push((
                kind,
                Vec::new(),
                vec![query_evidence(
                    format!("{} and its definitional operands", measure),
                    measures,
                    Vec::new(),
                )],
            ));
        }
    }

    // --- Contribution / member movement -------------------------------------
    for slice in &observation.slices {
        let additive = is_additive_over(resolved, &slice.dimension);
        let mut provenance: Vec<AppliedAttr> = Vec::new();
        if let Some(agg) = resolved.aggregation.as_ref() {
            let (effective, per_dimension) = effective_additivity(&agg.value, &slice.dimension);
            // "lastValue over Product" is a PER-DIMENSION claim, and printing it
            // for a spec whose `byDimension` is empty attributes to the document
            // a statement it never made - about a rollup that has no meaning
            // along that dimension anyway. Say "over <dimension>" only when the
            // document really did name it; otherwise report the model-wide
            // default as what it is.
            provenance.push(attr(
                "aggregation",
                if per_dimension {
                    format!("{} over {}", additivity_word(effective), slice.dimension)
                } else {
                    additivity_word(effective).to_string()
                },
                &agg.source,
            ));
        }
        let evidence = query_evidence(
            format!("{} by {}", measure, slice.dimension),
            vec![measure.clone()],
            vec![slice.dimension.to_string()],
        );
        for kind in contributions_for(&measure, slice, additive) {
            kinds.push((kind, provenance.clone(), vec![evidence.clone()]));
        }
    }

    // --- Series facts, from core/insights -----------------------------------
    let series = timeseries::Series::new(
        Subject::measure(&measure),
        &observation.labels,
        &observation.values,
    );
    // WHAT ONE POINT OF THIS SERIES MEANS, which the statistics crate cannot
    // know and the strategy document does. See `Cadence::expected_cycle`.
    let cycle = resolved.cadence.as_ref().and_then(|c| c.value.expected_cycle());
    let mut series_facts: Vec<FactKind> = Vec::new();
    for (_, build) in SERIES_BUILDERS {
        series_facts.extend(build(&series, cycle));
    }
    for inner in series_facts {
        kinds.push((
            ModelFactKind::Series { inner },
            Vec::new(),
            vec![series_evidence.clone()],
        ));
    }

    (finish_facts(kinds, resolved, locale), run)
}

/// One fact as `facts_for_measure` builds it, before it is judged worth showing.
///
/// The triple was an anonymous tuple inside one loop; naming it is what let the
/// three jobs that loop was doing come apart.
pub type DraftFact = (ModelFactKind, Vec<AppliedAttr>, Vec<WireEvidence>);

/// Suppress, score and narrate — the stage AFTER generation.
///
/// IT WAS ONE LOOP DOING FOUR JOBS, and that is why nothing could reorder or
/// withhold a fact without also being able to invent one. Generation decides
/// what the numbers ARE; this decides what is worth saying about them. They are
/// different questions, they have different answers for different measures, and
/// only the second is something a person could reasonably want to change.
///
/// Splitting them is what makes a policy seam possible at all (see
/// `apply_fact_policy`): a caller can be handed the finished facts and allowed
/// to drop or reorder them, and cannot reach the arithmetic that produced them.
pub fn finish_facts(
    kinds: Vec<DraftFact>,
    resolved: &ResolvedMeasure,
    locale: &LocaleSettings,
) -> Vec<ModelFact> {
    let mut facts: Vec<ModelFact> = Vec::new();
    for (kind, provenance, evidence) in kinds {
        // SUPPRESSION IS PART OF JUDGING, NOT OF GENERATING. A suppressed fact
        // is one the document asked not to be told about; the numbers behind it
        // were still computed, and a later stage that wanted them could have
        // them.
        if kind
            .suppressible_kind()
            .is_some_and(|k| resolved.suppressed_kinds.contains(&k))
        {
            continue;
        }
        let text = narrate_fact(&kind, resolved.unit.as_ref().map(|u| u.value), locale);
        facts.push(ModelFact {
            id: kind.id(),
            score: score_for(&kind, resolved),
            kind,
            text,
            evidence,
            provenance,
        });
    }
    facts
}

/// Why a fact policy was refused, or `None` when it may stand.
///
/// A POLICY MAY REORDER AND WITHHOLD. IT MAY NEVER EMIT. That is the whole
/// boundary, and it is enforced by checking the answer rather than by trusting
/// the policy: whatever comes back must be a SUBSET of what went in, matched by
/// fact id, with no duplicates. A policy that returns an id nobody generated is
/// asserting something, and asserting is the one thing this seam does not do.
///
/// The check is total and cheap, which is why the seam is safe to open long
/// before a fact PRODUCER is (§13 of the design doc): reordering cannot put a
/// number in front of a reader that the model did not compute.
pub fn fact_policy_refusal(before: &[ModelFact], after: &[String]) -> Option<String> {
    let allowed: BTreeSet<&str> = before.iter().map(|f| f.id.as_str()).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for id in after {
        if !allowed.contains(id.as_str()) {
            return Some(format!(
                "the policy returned '{id}', which no measure produced. A policy may reorder and \
                 withhold; it cannot introduce a fact"
            ));
        }
        if !seen.insert(id.as_str()) {
            return Some(format!(
                "the policy returned '{id}' twice. A policy returns a subset, so one fact cannot \
                 appear in the report more than once"
            ));
        }
    }
    None
}

/// Apply a ranking/suppression policy to a measure's finished facts.
///
/// The policy states an ORDER OF IDS. Everything it leaves out is withheld;
/// everything it names keeps the fact the engine built, untouched — so a policy
/// cannot alter a number, a sentence or a piece of evidence, only whether and
/// where it appears.
pub fn apply_fact_policy(facts: Vec<ModelFact>, order: &[String]) -> Result<Vec<ModelFact>, String> {
    if let Some(why) = fact_policy_refusal(&facts, order) {
        return Err(why);
    }
    let mut by_id: BTreeMap<&str, &ModelFact> = BTreeMap::new();
    for f in &facts {
        by_id.insert(f.id.as_str(), f);
    }
    Ok(order
        .iter()
        .filter_map(|id| by_id.get(id.as_str()).map(|f| (*f).clone()))
        .collect())
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRun {
    pub model_label: String,
    pub locale_id: String,
    pub measures: Vec<MeasureRun>,
    pub facts: Vec<ModelFact>,
    pub dropped: usize,
    pub notes: Vec<String>,
}

/// Assemble one run: rank the facts, keep the budget, and report what the
/// budget threw away rather than hiding it.
pub fn build_run(
    model_label: &str,
    locale: &LocaleSettings,
    per_measure: Vec<(Vec<ModelFact>, MeasureRun)>,
    notes: Vec<String>,
) -> ModelRun {
    let mut facts: Vec<ModelFact> = Vec::new();
    let mut measures: Vec<MeasureRun> = Vec::new();
    for (f, run) in per_measure {
        facts.extend(f);
        measures.push(run);
    }
    // Score descending, then id ascending. The id tie-break is what makes two
    // runs over the same numbers byte-identical.
    facts.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    let dropped = facts.len().saturating_sub(MAX_FACTS);
    facts.truncate(MAX_FACTS);

    ModelRun {
        model_label: model_label.to_string(),
        locale_id: locale.locale_id.clone(),
        measures,
        facts,
        dropped,
        notes,
    }
}

/// Numbers only, no prose: what a Tier-1 narrator is given to work from.
///
/// IT MUST CARRY THE IDS, and for a while it did not. This function emitted a
/// bare array of kinds — no id, no score, no evidence — while its own doc
/// comment named the consumer it was for. The whole point of the field, stated
/// in `open-items.md` 2.AI.5, is that "factsJson carries fact ids precisely so a
/// later narrator can be checked for coverage": M6 asks a model for sentences
/// each TAGGED with the facts it covers, and then deletes any sentence citing a
/// number its cited facts do not contain. Without ids there is nothing to tag
/// and nothing to check, so the model path could never have been narrated
/// safely at all. The shape now matches the core path's `FactsDocument`
/// (`core/insights/src/lib.rs`), because a narrator should not have to ask which
/// half of the product a bundle came from.
///
/// `text` stays out deliberately. A narrator that can see our sentences
/// paraphrases them instead of reading the numbers, which is the one thing this
/// field exists to prevent.
fn facts_json(run: &ModelRun) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Record<'a> {
        id: &'a str,
        score: f64,
        kind: &'a ModelFactKind,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Document<'a> {
        model_label: &'a str,
        facts: Vec<Record<'a>>,
    }

    let document = Document {
        model_label: &run.model_label,
        facts: run
            .facts
            .iter()
            .map(|f| Record { id: &f.id, score: f.score, kind: &f.kind })
            .collect(),
    };
    // A serialisation failure must not read as "nothing was found"; an empty
    // array would. The core path makes the same choice for the same reason.
    serde_json::to_string(&document)
        .unwrap_or_else(|e| format!("{{\"error\":\"facts could not be serialised: {}\"}}", e))
}

fn markdown(run: &ModelRun) -> String {
    let mut out = format!("## {}\n\n", run.model_label);
    if run.facts.is_empty() {
        out.push_str("No findings cleared their materiality thresholds.\n");
    }
    for fact in &run.facts {
        out.push_str("- ");
        out.push_str(&fact.text);
        out.push('\n');
    }
    if run.dropped > 0 {
        out.push_str(&format!("\nand {} more.\n", run.dropped));
    }
    if !run.notes.is_empty() {
        out.push_str("\n### Notes\n\n");
        for note in &run.notes {
            out.push_str("- ");
            out.push_str(note);
            out.push('\n');
        }
    }
    out
}

/// Map a run onto the seam the frontend already codes against.
pub fn to_wire(run: &ModelRun) -> WireBundle {
    WireBundle {
        source: BundleSource::Model,
        insights: run
            .facts
            .iter()
            .map(|f| WireInsight {
                id: f.id.clone(),
                kind: f.kind.kind_key(),
                score: f.score,
                text: f.text.clone(),
                evidence: f.evidence.clone(),
                provenance: f
                    .provenance
                    .iter()
                    .map(|a| WireProvenance {
                        attribute: a.attr.clone(),
                        value: a.value.clone(),
                        source: attr_source_id(&a.source),
                    })
                    .collect(),
            })
            .collect(),
        dropped: run.dropped,
        markdown: markdown(run),
        facts_json: facts_json(run),
        notes: run.notes.clone(),
    }
}

// ---------------------------------------------------------------------------
// Measure-AST reading (the definitional half of the plan)
// ---------------------------------------------------------------------------

/// The definitional shape of a measure, BEFORE any of it has been measured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverShape {
    /// Measure references with the sign each carries into the parent.
    Sum(Vec<(String, i32)>),
    Ratio { numerator: String, denominator: String },
}

impl DriverShape {
    /// Every measure the shape needs a series for.
    pub fn operands(&self) -> Vec<String> {
        match self {
            DriverShape::Sum(terms) => terms.iter().map(|(n, _)| n.clone()).collect(),
            DriverShape::Ratio {
                numerator,
                denominator,
            } => vec![numerator.clone(), denominator.clone()],
        }
    }
}

/// Read a measure's definition into a decomposable shape, walking at most
/// `MAX_DRIVER_DEPTH` levels of referenced measures.
///
/// `lookup` returns the expression behind a measure name; the caller supplies
/// it so this stays testable without a `DataModel`. A measure already on the
/// path is NOT expanded again — a model can define `A = B + C` and `C = A - D`,
/// and following that would recurse until the stack ran out.
pub fn driver_shape<F>(expression: &bi_engine::Expression, lookup: &F) -> Option<DriverShape>
where
    F: Fn(&str) -> Option<bi_engine::Expression>,
{
    use bi_engine::{ArithmeticOp, Expression};

    // A ratio is only decomposable when BOTH sides name a measure. `SUM(a) /
    // SUM(b)` has no sub-measure to attribute to, and inventing labels for the
    // two aggregates would put names in a sentence that appear nowhere in the
    // model.
    if let Expression::BinaryOp {
        left,
        op: ArithmeticOp::Divide,
        right,
    } = expression
    {
        if let (Expression::MeasureRef(n), Expression::MeasureRef(d)) =
            (left.as_ref(), right.as_ref())
        {
            return Some(DriverShape::Ratio {
                numerator: n.clone(),
                denominator: d.clone(),
            });
        }
        return None;
    }

    let mut terms: Vec<(String, i32)> = Vec::new();
    let mut path: BTreeSet<String> = BTreeSet::new();
    if !collect_sum_terms(expression, 1, lookup, &mut path, &mut terms, 0) {
        return None;
    }
    if terms.len() < 2 {
        // One term is not a decomposition, it is a rename.
        return None;
    }
    Some(DriverShape::Sum(terms))
}

fn collect_sum_terms<F>(
    expression: &bi_engine::Expression,
    sign: i32,
    lookup: &F,
    path: &mut BTreeSet<String>,
    out: &mut Vec<(String, i32)>,
    depth: usize,
) -> bool
where
    F: Fn(&str) -> Option<bi_engine::Expression>,
{
    use bi_engine::{ArithmeticOp, Expression};
    match expression {
        Expression::BinaryOp {
            left,
            op: ArithmeticOp::Add,
            right,
        } => {
            collect_sum_terms(left, sign, lookup, path, out, depth)
                && collect_sum_terms(right, sign, lookup, path, out, depth)
        }
        Expression::BinaryOp {
            left,
            op: ArithmeticOp::Subtract,
            right,
        } => {
            collect_sum_terms(left, sign, lookup, path, out, depth)
                && collect_sum_terms(right, -sign, lookup, path, out, depth)
        }
        Expression::MeasureRef(name) => {
            // Expand a referenced measure only while there is depth left AND it
            // is itself a chain; otherwise it stays a leaf, which is the honest
            // level of detail for a measure defined as an aggregate.
            if depth + 1 < MAX_DRIVER_DEPTH && !path.contains(name) {
                if let Some(inner) = lookup(name) {
                    let is_chain = matches!(
                        &inner,
                        Expression::BinaryOp {
                            op: ArithmeticOp::Add | ArithmeticOp::Subtract,
                            ..
                        }
                    );
                    if is_chain {
                        path.insert(name.clone());
                        let ok =
                            collect_sum_terms(&inner, sign, lookup, path, out, depth + 1);
                        path.remove(name);
                        return ok;
                    }
                }
            }
            out.push((name.clone(), sign));
            true
        }
        // Anything else in the chain (a literal, a multiplication, a bare
        // aggregate) means the deltas would no longer add up, so there is no
        // exact decomposition to offer.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::strategy::{
        AggregationSpec, Applied, MeasureFacts, ModelStrategy, Rule, Scope, ScopeValue,
        Suppression, TableFacts,
    };
    use std::collections::BTreeMap;

    fn locale() -> LocaleSettings {
        LocaleSettings::from_locale_id("en-US")
    }

    fn additive() -> Applied<AggregationSpec> {
        Applied::new(
            AggregationSpec {
                default: Additivity::Additive,
                by_dimension: BTreeMap::new(),
            },
            AttrSource::Base,
        )
    }

    fn non_additive() -> Applied<AggregationSpec> {
        Applied::new(
            AggregationSpec {
                default: Additivity::NonAdditive,
                by_dimension: BTreeMap::new(),
            },
            AttrSource::Strategy,
        )
    }

    fn resolved(measure: &str) -> ResolvedMeasure {
        ResolvedMeasure {
            measure: measure.to_string(),
            aggregation: Some(additive()),
            ..ResolvedMeasure::default()
        }
    }

    /// Two periods of a measure, WITH NO TARGET, no bands, no dimensions and no
    /// driver.
    ///
    /// THE ABSENCES ARE IN THE NAME BECAUSE ONE OF THEM HID A BUG FOR FOUR
    /// ROUNDS. `MeasureObservation` derives `Default`, so `..default()` leaves
    /// `target_value: None` — and the Variance fact is built OUTSIDE the
    /// materiality gate, so "the run emits nothing below the floor" is true
    /// only while there is no target. Every fixture on that path had been built
    /// this way, so 295 tests agreed with a premise none of them stated. A test
    /// asserting an ABSENCE here is asserting about this helper's defaults; if
    /// that is the point, say so in the assertion, and if it is not, set the
    /// field.
    fn observation_without_a_target(measure: &str, first: f64, last: f64) -> MeasureObservation {
        MeasureObservation {
            measure: measure.to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![first, last],
            ..MeasureObservation::default()
        }
    }

    fn slice(dimension: &str, members: Vec<MemberSeries>) -> DimensionSlice {
        DimensionSlice {
            dimension: dimension.parse().expect("a Table[Column] fixture"),
            members,
        }
    }

    fn kinds_of(facts: &[ModelFact]) -> Vec<String> {
        facts.iter().map(|f| f.kind.kind_key()).collect()
    }

    // -- decomposition -----------------------------------------------------

    #[test]
    fn the_definitional_decomposition_of_a_difference_is_exact() {
        // Margin = Revenue - Cost. Revenue rose 2.0 and Cost rose 6.1, so
        // Margin fell 4.1 and NOTHING is left over.
        let terms = vec![
            DriverTerm {
                measure: "Revenue".to_string(),
                coefficient: 1.0,
                first: 100.0,
                last: 102.0,
            },
            DriverTerm {
                measure: "Cost".to_string(),
                coefficient: -1.0,
                first: 60.0,
                last: 66.1,
            },
        ];
        let total_delta = (102.0 - 66.1) - (100.0 - 60.0);
        let d = additive_decomposition(total_delta, &terms);

        assert_eq!(d.kind, DecompositionKind::Difference);
        assert!(
            (total_delta - (-4.1)).abs() < 1e-9,
            "the fixture's own arithmetic: {}",
            total_delta
        );
        assert!((d.parts[0].movement.unwrap() - 2.0).abs() < 1e-9);
        assert!((d.parts[1].movement.unwrap() - 6.1).abs() < 1e-9);
        assert!((d.parts[0].effect - 2.0).abs() < 1e-9);
        assert!((d.parts[1].effect - (-6.1)).abs() < 1e-9);
        let summed: f64 = d.parts.iter().map(|p| p.effect).sum();
        assert!(
            (summed - total_delta).abs() < 1e-9,
            "the effects must reconstruct the parent's movement exactly, got {}",
            summed
        );
        assert_eq!(d.residual, 0.0, "an exact decomposition leaves nothing over");

        let text = narrate_fact(
            &ModelFactKind::DefinitionalDriver {
                measure: "Margin".to_string(),
                kind: d.kind,
                total_delta,
                parts: d.parts,
                residual: d.residual,
            },
            None,
            &locale(),
        );
        assert!(text.contains("Margin fell 4.1"), "{}", text);
        assert!(text.contains("Revenue rose 2"), "{}", text);
        assert!(text.contains("Cost rose 6.1"), "{}", text);
        assert!(text.contains("residual 0"), "{}", text);
    }

    #[test]
    fn a_ratio_decomposition_states_its_residual() {
        // Revenue per order: 100/10 = 10, then 120/12 = 10. The ratio did not
        // move AT ALL, but the numerator and the denominator both did, and a
        // first-order split of a movement of zero leaves a real remainder.
        let d = ratio_decomposition("Revenue", "Orders", 100.0, 120.0, 10.0, 12.0)
            .expect("a non-zero denominator decomposes");

        assert_eq!(d.kind, DecompositionKind::Ratio);
        assert!((d.parts[0].effect - 2.0).abs() < 1e-12, "numerator effect");
        assert!((d.parts[1].effect + 2.0).abs() < 1e-12, "denominator effect");
        assert!((d.parts[2].effect + 0.4).abs() < 1e-12, "interaction");
        assert_eq!(d.parts[2].label, "interaction");
        assert!(
            (d.residual - 0.4).abs() < 1e-12,
            "the dropped second-order term is 0.4, and it must be STATED: {}",
            d.residual
        );

        let text = narrate_fact(
            &ModelFactKind::DefinitionalDriver {
                measure: "Revenue per order".to_string(),
                kind: d.kind,
                total_delta: 0.0,
                parts: d.parts,
                residual: d.residual,
            },
            None,
            &locale(),
        );
        assert!(
            text.contains("residual 0.4"),
            "a decomposition that hides its residual lies: {}",
            text
        );
    }

    #[test]
    fn a_ratio_over_a_zero_denominator_decomposes_to_nothing_rather_than_infinity() {
        assert!(ratio_decomposition("N", "D", 10.0, 20.0, 0.0, 5.0).is_none());
        assert!(ratio_decomposition("N", "D", 10.0, 20.0, 5.0, 0.0).is_none());
    }

    // -- contribution ------------------------------------------------------

    #[test]
    fn dimensional_contributions_sum_to_the_total_delta() {
        let s = slice(
            "Product[Category]",
            vec![
                MemberSeries::new("Gadgets", 100.0, 160.0),
                MemberSeries::new("Widgets", 80.0, 90.0),
                MemberSeries::new("Doodads", 50.0, 45.0),
                MemberSeries::new("Trinkets", 20.0, 22.0),
                MemberSeries::new("Gizmos", 10.0, 11.0),
                MemberSeries::new("Thingumies", 5.0, 7.0),
                MemberSeries::new("Whatsits", 4.0, 3.0),
            ],
        );
        let facts = contributions_for("Revenue", &s, true);
        assert_eq!(facts.len(), 1, "one contribution fact per dimension");

        let ModelFactKind::Contribution {
            total_delta,
            members,
            others,
            ..
        } = &facts[0]
        else {
            panic!("an additive measure gets a Contribution, got {:?}", facts[0]);
        };
        // 60 + 10 - 5 + 2 + 1 + 2 - 1.
        assert!((total_delta - 69.0).abs() < 1e-9, "{}", total_delta);
        assert_eq!(members.len(), CONTRIBUTION_TOP_N);
        assert_eq!(members[0].member, "Gadgets", "ranked by |delta|");

        let others = others.as_ref().expect("two members fall outside the top 5");
        let summed: f64 = members.iter().map(|m| m.delta).sum::<f64>() + others.delta;
        assert!(
            (summed - total_delta).abs() < 1e-9,
            "the named members plus everything else must be the whole movement: {} vs {}",
            summed,
            total_delta
        );
        let shares: f64 = members
            .iter()
            .chain(std::iter::once(others))
            .map(|m| m.share.expect("an additive contribution carries shares"))
            .sum();
        assert!((shares - 1.0).abs() < 1e-9, "shares sum to one, got {}", shares);
    }

    #[test]
    fn a_non_additive_measure_gets_no_share_claim() {
        // Margin % is a ratio. Its members' movements do not add up to the
        // company's movement, so a share of the total is arithmetic nonsense.
        let s = slice(
            "Product[Category]",
            vec![
                MemberSeries::new("Gadgets", 0.40, 0.31),
                MemberSeries::new("Widgets", 0.22, 0.25),
            ],
        );
        let facts = contributions_for("Margin %", &s, false);

        assert!(!facts.is_empty(), "a non-additive measure still says what happened");
        for fact in &facts {
            match fact {
                ModelFactKind::MemberMove { .. } => {}
                other => panic!("a non-additive measure must not get a share claim: {:?}", other),
            }
            // Structurally, not by wording: a `MemberMove` has no `share`
            // field at all, so nothing downstream — the pane, `factsJson`, a
            // model-written paragraph — can find a share to print.
            let json = serde_json::to_value(fact).expect("serializes");
            assert!(
                json.get("share").is_none(),
                "a non-additive member carries no share: {}",
                json
            );
            let text = narrate_fact(fact, None, &locale());
            assert!(
                !text.contains(" of the total)"),
                "the share parenthetical is the Contribution wording and must not appear: {}",
                text
            );
            assert!(text.contains("no share of the total is claimed"), "{}", text);
        }
    }

    #[test]
    fn an_additive_measure_does_get_a_share_claim() {
        // The positive control for the gate above: same members, same numbers,
        // additivity flipped, and the share appears.
        let s = slice(
            "Product[Category]",
            vec![
                MemberSeries::new("Gadgets", 100.0, 160.0),
                MemberSeries::new("Widgets", 80.0, 90.0),
            ],
        );
        let facts = contributions_for("Revenue", &s, true);
        let ModelFactKind::Contribution { members, .. } = &facts[0] else {
            panic!("expected a Contribution");
        };
        assert!(members.iter().all(|m| m.share.is_some()));
        assert!(narrate_fact(&facts[0], None, &locale()).contains("of the total"));
    }

    #[test]
    fn a_contribution_the_top_members_cannot_explain_is_not_emitted() {
        // Six members that cancel each other: the top five account for less
        // than half of a tiny net movement, so naming them would point the
        // reader at the wrong place.
        let s = slice(
            "Product[Category]",
            vec![
                MemberSeries::new("A", 0.0, 100.0),
                MemberSeries::new("B", 0.0, -99.0),
                MemberSeries::new("C", 0.0, 98.0),
                MemberSeries::new("D", 0.0, -97.0),
                MemberSeries::new("E", 0.0, 96.0),
                MemberSeries::new("F", 0.0, -95.0),
            ],
        );
        assert!(contributions_for("Revenue", &s, true).is_empty());
    }

    // -- materiality -------------------------------------------------------

    #[test]
    fn a_change_below_materiality_produces_no_fact() {
        let mut r = resolved("Revenue");
        r.materiality = Some(Applied::new(
            Materiality::Relative { value: 0.05 },
            AttrSource::Strategy,
        ));
        // 100 -> 102 is 2%, and the business said 5%.
        let (facts, _) = facts_for_measure(&observation_without_a_target("Revenue", 100.0, 102.0), &r, &locale());
        assert!(
            !kinds_of(&facts).contains(&"change".to_string()),
            "a movement the business calls noise produces NO fact: {:?}",
            kinds_of(&facts)
        );
    }

    #[test]
    fn a_change_above_materiality_produces_a_fact() {
        let mut r = resolved("Revenue");
        r.materiality = Some(Applied::new(
            Materiality::Relative { value: 0.05 },
            AttrSource::Strategy,
        ));
        // 100 -> 112 is 12%.
        let (facts, run) = facts_for_measure(&observation_without_a_target("Revenue", 100.0, 112.0), &r, &locale());
        assert!(kinds_of(&facts).contains(&"change".to_string()));
        assert_eq!(run.delta, Some(12.0));
    }

    #[test]
    fn an_absolute_materiality_is_measured_in_the_measures_own_unit() {
        assert!(clears_materiality(
            Some(&Materiality::Absolute { value: 10.0 }),
            100.0,
            -12.0
        ));
        assert!(!clears_materiality(
            Some(&Materiality::Absolute { value: 10.0 }),
            100.0,
            9.9
        ));
        // A relative floor off a zero base is undefined, so any real movement
        // counts rather than none.
        assert!(clears_materiality(
            Some(&Materiality::Relative { value: 0.5 }),
            0.0,
            1.0
        ));
    }

    // -- direction ---------------------------------------------------------

    #[test]
    fn a_suppressed_direction_produces_a_fact_with_numbers_and_no_favourability() {
        let mut r = resolved("Returns");
        r.direction = Some(Applied::new(
            Direction::LowerIsBetter,
            AttrSource::Strategy,
        ));
        r.suppressions = vec![Suppression {
            attribute: Attribute::Direction,
            rule: "returns-are-good-in-refunds".to_string(),
            reason: "the fact aggregates over departments the rule covers only some of"
                .to_string(),
        }];

        let (facts, run) = facts_for_measure(&observation_without_a_target("Returns", 100.0, 130.0), &r, &locale());
        let change = facts
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("the numbers still ship");

        let ModelFactKind::Change {
            delta,
            favourability,
            ..
        } = &change.kind
        else {
            panic!("expected a Change");
        };
        assert_eq!(*delta, 30.0, "the NUMBERS are unaffected by the suppression");
        assert!(
            favourability.is_none(),
            "a withheld direction carries no favourability at all"
        );
        assert!(run.favourability.is_none());

        let named = change
            .provenance
            .iter()
            .find(|p| p.attr == "direction")
            .expect("the suppression must be named in provenance");
        assert_eq!(
            named.source,
            CoreAttrSource::Rule("returns-are-good-in-refunds".to_string()),
            "the reader's next question is 'says who?'"
        );
        assert!(named.value.starts_with("withheld:"), "{}", named.value);
    }

    #[test]
    fn lower_is_better_flips_favourability() {
        assert_eq!(
            favourability_of(Direction::HigherIsBetter, 5.0),
            Some(Favourability::Better)
        );
        assert_eq!(
            favourability_of(Direction::LowerIsBetter, 5.0),
            Some(Favourability::Worse)
        );
        assert_eq!(
            favourability_of(Direction::HigherIsBetter, -5.0),
            Some(Favourability::Worse)
        );
        assert_eq!(
            favourability_of(Direction::LowerIsBetter, -5.0),
            Some(Favourability::Better)
        );
        assert_eq!(
            favourability_of(Direction::Neutral, -5.0),
            Some(Favourability::Neutral)
        );
        // "Good means inside a band" cannot be read off a delta.
        assert_eq!(favourability_of(Direction::TargetBand, -5.0), None);

        // ...and the same flip reaches the sentence.
        let mut better = resolved("Cost");
        better.direction = Some(Applied::new(Direction::LowerIsBetter, AttrSource::Strategy));
        let (facts, _) = facts_for_measure(&observation_without_a_target("Cost", 100.0, 80.0), &better, &locale());
        let text = &facts
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("a 20% fall clears the default gate")
            .text;
        assert!(text.contains("which is better"), "{}", text);
    }

    // -- dimension planning ------------------------------------------------

    fn star_facts() -> ModelFacts {
        let mut facts = ModelFacts {
            date_table: Some("Date".to_string()),
            ..ModelFacts::default()
        };
        for (table, columns) in [
            ("Sales", vec!["Amount", "ProductKey", "Date"]),
            ("Product", vec!["ProductKey", "Category"]),
            ("Date", vec!["Date", "Month"]),
            // Reachable only THROUGH Product: two hops from Sales.
            ("Supplier", vec!["SupplierKey", "Country"]),
        ] {
            facts.tables.insert(
                table.to_string(),
                TableFacts {
                    columns: columns.iter().map(|c| c.to_string()).collect(),
                    ..TableFacts::default()
                },
            );
        }
        facts.relationships = vec![
            (
                QualifiedColumn::new("Sales", "ProductKey"),
                QualifiedColumn::new("Product", "ProductKey"),
            ),
            (
                QualifiedColumn::new("Sales", "Date"),
                QualifiedColumn::new("Date", "Date"),
            ),
            (
                QualifiedColumn::new("Product", "SupplierKey"),
                QualifiedColumn::new("Supplier", "SupplierKey"),
            ),
        ];
        facts.measures.insert(
            "Revenue".to_string(),
            MeasureFacts {
                fact_table: Some("Sales".to_string()),
                ..MeasureFacts::default()
            },
        );
        facts
    }

    #[test]
    fn a_never_slice_by_dimension_produces_no_contribution() {
        let mut r = resolved("Revenue");
        r.analysis_dimensions = vec![
            QualifiedColumn::new("Product", "Category"),
            QualifiedColumn::new("Date", "Month"),
        ];
        r.never_slice_by = vec![QualifiedColumn::new("Date", "Month")];

        let plan = plan_dimensions(&r, &star_facts(), Some("Sales"));
        assert_eq!(
            plan.dimensions,
            vec![QualifiedColumn::new("Product", "Category")],
            "an excluded dimension is never queried"
        );

        // ...and nothing downstream can put it back: with no slice for it,
        // there is no contribution fact naming it.
        let mut obs = observation_without_a_target("Revenue", 100.0, 140.0);
        obs.slices = plan
            .dimensions
            .iter()
            .map(|d| {
                DimensionSlice {
                    dimension: d.clone(),
                    members: vec![MemberSeries::new("Gadgets", 100.0, 140.0)],
                }
            })
            .collect();
        let (facts, _) = facts_for_measure(&obs, &r, &locale());
        assert!(
            !facts.iter().any(|f| f.text.contains("Date[Month]")),
            "no fact may name an excluded dimension"
        );
    }

    #[test]
    fn a_dimension_that_is_not_excluded_is_sliced() {
        // The positive control: the same measure, the same model, without the
        // exclusion, and Date[Month] is planned.
        let mut r = resolved("Revenue");
        r.analysis_dimensions = vec![
            QualifiedColumn::new("Product", "Category"),
            QualifiedColumn::new("Date", "Month"),
        ];
        let plan = plan_dimensions(&r, &star_facts(), Some("Sales"));
        assert_eq!(plan.dimensions.len(), 2);
        assert!(plan.notes.is_empty(), "{:?}", plan.notes);
    }

    #[test]
    fn an_unreachable_dimension_is_reported_in_notes_rather_than_dropped() {
        let mut r = resolved("Revenue");
        r.analysis_dimensions = vec![
            QualifiedColumn::new("Product", "Category"),
            // Two hops from Sales. The executor refuses it, so the planner
            // must SAY so rather than quietly omitting the section.
            QualifiedColumn::new("Supplier", "Country"),
        ];
        let plan = plan_dimensions(&r, &star_facts(), Some("Sales"));

        assert_eq!(plan.dimensions, vec![QualifiedColumn::new("Product", "Category")]);
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        let note = &plan.notes[0];
        assert!(note.contains("Supplier[Country]"), "{}", note);
        assert!(note.contains("not directly related"), "{}", note);
    }

    #[test]
    fn a_measure_with_no_analysis_dimensions_says_so_instead_of_silently_having_no_breakdown() {
        // The DEFAULT state now that inference leaves the list empty. Every
        // other way a dimension falls out of the plan pushes a note; the empty
        // list pushed none, because the loop never ran — so the measure had no
        // breakdown and nothing said why. Honest-but-invisible is the failure
        // this layer exists to prevent, and it was reachable through the one
        // path with no note in it.
        let r = resolved("Revenue");
        assert!(r.analysis_dimensions.is_empty(), "the fixture must start empty");
        let plan = plan_dimensions(&r, &star_facts(), Some("Sales"));

        assert!(plan.dimensions.is_empty());
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        let note = &plan.notes[0];
        assert!(note.contains("Revenue"), "the note names the measure: {note}");
        // ...and it says what to DO, because "no analysis dimensions" is a
        // sentence only somebody who already knows this layer can act on.
        assert!(note.contains("Strategy tab"), "the note says where to fix it: {note}");
    }

    #[test]
    fn only_the_first_four_dimensions_are_queried_and_the_rest_are_named() {
        let mut facts = star_facts();
        facts.tables.get_mut("Product").unwrap().columns.extend(
            ["A", "B", "C", "D", "E"].iter().map(|c| c.to_string()),
        );
        let mut r = resolved("Revenue");
        r.analysis_dimensions = ["Category", "A", "B", "C", "D", "E"]
            .iter()
            .map(|c| QualifiedColumn::new("Product", *c))
            .collect();

        let plan = plan_dimensions(&r, &facts, Some("Sales"));
        assert_eq!(plan.dimensions.len(), MAX_DIMENSIONS_PER_MEASURE);
        assert_eq!(plan.notes.len(), 2, "the two it could not reach are named");
    }

    // -- measure choice and time axis --------------------------------------

    #[test]
    fn the_declared_priority_order_is_analysed_first() {
        let mut facts = star_facts();
        for name in ["Alpha", "Cost", "Zulu"] {
            facts.measures.insert(name.to_string(), MeasureFacts::default());
        }
        let doc = StrategyDoc {
            version: 1,
            model: ModelStrategy {
                priority: vec!["Cost".to_string(), "Revenue".to_string()],
                ..ModelStrategy::default()
            },
            ..StrategyDoc::default()
        };
        let chosen = choose_measures(&doc, &facts, &[]);
        assert_eq!(chosen[0], "Cost");
        assert_eq!(chosen[1], "Revenue");
        // Everything else follows in name order, so the choice never depends on
        // map iteration.
        assert_eq!(&chosen[2..], &["Alpha".to_string(), "Zulu".to_string()]);
    }

    #[test]
    fn an_explicit_request_wins_over_the_declared_priority() {
        let facts = star_facts();
        let doc = StrategyDoc {
            version: 1,
            ..StrategyDoc::default()
        };
        let chosen = choose_measures(&doc, &facts, &["Revenue".to_string(), "Ghost".to_string()]);
        assert_eq!(chosen, vec!["Revenue".to_string()], "an unknown measure is dropped");
    }

    #[test]
    fn no_time_axis_is_none_rather_than_an_invented_ordering() {
        // THROUGH `plan_time_axis`, BECAUSE THAT IS THE ONLY WAY TO ASK, and
        // the only way anything else asks: `model_commands.rs` takes the whole
        // plan and extends `notes` from it. There is deliberately no
        // axis-only convenience wrapper for a test to reach for - one existed,
        // it threw the plan's notes away, and its only callers were assertions
        // like this one, so the guessed-calendar note it dropped was invisible
        // to every guard in the file. Read the axis off the plan.
        let mut facts = star_facts();
        facts.date_table = None;
        let doc = StrategyDoc {
            version: 1,
            ..StrategyDoc::default()
        };
        assert_eq!(plan_time_axis(&doc, &facts, &[]).axis, None);

        // A declared axis wins even when a date table exists.
        let doc = StrategyDoc {
            version: 1,
            model: ModelStrategy {
                default_time_axis: Some(QualifiedColumn::new("Date", "Month")),
                ..ModelStrategy::default()
            },
            ..StrategyDoc::default()
        };
        assert_eq!(
            plan_time_axis(&doc, &star_facts(), &[QualifiedColumn::new("Date", "Date")]).axis,
            Some(QualifiedColumn::new("Date", "Month"))
        );
    }

    #[test]
    fn a_time_axis_resting_on_a_guessed_calendar_is_announced() {
        // A GUESS THAT DRIVES EVERY TIME FACT MUST NOT LOOK LIKE A DECLARATION.
        // `facts.rs` infers a date table on a model nobody marked, which is what
        // gives an imported star schema a time axis at all - and every trend,
        // change point and seasonality claim in the run then rests on it.
        let mut facts = star_facts();
        facts.calendar_source = Some(CalendarSource::Inferred);
        let doc = StrategyDoc {
            version: 1,
            ..StrategyDoc::default()
        };
        let plan = plan_time_axis(&doc, &facts, &[QualifiedColumn::new("Date", "Date")]);
        assert_eq!(plan.axis, Some(QualifiedColumn::new("Date", "Date")));
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        assert!(
            plan.notes[0].contains("guessed") && plan.notes[0].contains("Date"),
            "the note must name the guess and the table: {}",
            plan.notes[0]
        );

        // ...and the guess is still a guess when it arrives through a DRAFTED
        // `defaultTimeAxis`, which is exactly how it reaches a saved document:
        // `infer_default_time_axis` copies the inferred calendar's column there.
        let drafted = StrategyDoc {
            version: 1,
            model: ModelStrategy {
                default_time_axis: Some(QualifiedColumn::new("Date", "Month")),
                ..ModelStrategy::default()
            },
            ..StrategyDoc::default()
        };
        let plan = plan_time_axis(&drafted, &facts, &[]);
        assert_eq!(plan.axis, Some(QualifiedColumn::new("Date", "Month")));
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
    }

    #[test]
    fn a_declared_calendar_earns_no_note_and_neither_does_no_calendar_at_all() {
        // THE OTHER DIRECTION, and it is the half that decides whether the note
        // is worth reading: a note on every run is a note nobody reads.
        let mut facts = star_facts();
        facts.calendar_source = Some(CalendarSource::Declared);
        let doc = StrategyDoc {
            version: 1,
            ..StrategyDoc::default()
        };
        let plan = plan_time_axis(&doc, &facts, &[QualifiedColumn::new("Date", "Date")]);
        assert_eq!(plan.axis, Some(QualifiedColumn::new("Date", "Date")));
        assert!(plan.notes.is_empty(), "{:?}", plan.notes);

        // An axis that is not ON the calendar says nothing about the calendar,
        // however the calendar was arrived at.
        let mut guessed = star_facts();
        guessed.calendar_source = Some(CalendarSource::Inferred);
        let off_calendar = StrategyDoc {
            version: 1,
            model: ModelStrategy {
                default_time_axis: Some(QualifiedColumn::new("Sales", "Date")),
                ..ModelStrategy::default()
            },
            ..StrategyDoc::default()
        };
        let plan = plan_time_axis(&off_calendar, &guessed, &[]);
        assert_eq!(plan.axis, Some(QualifiedColumn::new("Sales", "Date")));
        assert!(plan.notes.is_empty(), "{:?}", plan.notes);

        // And with no calendar there is no axis and still no note: saying THAT
        // is the caller's own "this model has no time axis" line.
        let mut none = star_facts();
        none.date_table = None;
        none.calendar_source = None;
        let plan = plan_time_axis(&doc, &none, &[QualifiedColumn::new("Date", "Date")]);
        assert_eq!(plan.axis, None);
        assert!(plan.notes.is_empty(), "{:?}", plan.notes);
    }

    // -- provenance and determinism ----------------------------------------

    #[test]
    fn the_declared_cadence_decides_which_cycle_a_seasonal_measure_reports() {
        // `cadence`'s FIRST READER, wired end to end. The mechanism is proved in
        // `core/insights`; this proves the WIRING, which is the half that can be
        // inert without anyone noticing - a resolved attribute that reaches no
        // caller looks exactly like one that does.
        //
        // Same fixture shape as the core test: a clean 4-point cycle carrying a
        // 12-point envelope, so the scan's own maximum is the wrong answer.
        let values: Vec<f64> = (0..48)
            .map(|i| {
                let quarterly = if i % 4 == 0 { 10.0 } else { 0.0 };
                let annual = if i % 12 == 0 { 1.0 } else { 0.0 };
                100.0 + quarterly + annual
            })
            .collect();
        let obs = MeasureObservation {
            measure: "Revenue".to_string(),
            labels: (0..48).map(|i| format!("m{i}")).collect(),
            values,
            ..MeasureObservation::default()
        };

        let lag_of = |r: &ResolvedMeasure| -> Option<usize> {
            let (facts, _) = facts_for_measure(&obs, r, &locale());
            facts.iter().find_map(|f| match &f.kind {
                ModelFactKind::Series {
                    inner: FactKind::Seasonality { lag, .. },
                } => Some(*lag),
                _ => None,
            })
        };

        let mut r = resolved("Revenue");
        assert_eq!(lag_of(&r), Some(4), "with no cadence the scan's maximum stands");

        r.cadence = Some(Applied::new(Cadence::Monthly, AttrSource::Strategy));
        assert_eq!(
            lag_of(&r),
            Some(12),
            "a monthly measure reports the twelve-point year, not the noisier short lag"
        );

        // A cadence whose cycle the data does not carry changes nothing, so the
        // document states what a reader would RECOGNISE and never what is there.
        r.cadence = Some(Applied::new(Cadence::Weekly, AttrSource::Strategy));
        assert_eq!(lag_of(&r), Some(4));

        // And `yearly` has no cycle to prefer at all - a supra-annual period
        // needs years of history a series will not have.
        assert_eq!(Cadence::Yearly.expected_cycle(), None);
    }

    #[test]
    fn a_percentage_change_of_a_percentage_is_withheld_because_it_reads_as_the_move() {
        // `unit`'s FIRST READER, and it is a correctness fix rather than a
        // flourish. A margin going from 0.10 to 0.12 has risen by two
        // percentage POINTS and by twenty PER CENT; a sentence carrying both
        // invites the reader to take the larger number as the movement, and the
        // larger number is ten times the real one.
        let mut r = resolved("MarginPct");
        r.direction = Some(Applied::new(Direction::HigherIsBetter, AttrSource::Strategy));

        // Without a unit, the relative clause is printed as it always was.
        let (plain, _) = facts_for_measure(
            &observation_without_a_target("MarginPct", 0.10, 0.12),
            &r,
            &locale(),
        );
        let plain_change = plain
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("a change fact");
        assert!(
            plain_change.text.contains("20.0%"),
            "the relative change is the default: {}",
            plain_change.text
        );

        // Declared a percent, the clause goes and the absolute movement stands
        // alone - which is unambiguous whatever scale the measure is stored in.
        r.unit = Some(Applied::new(Unit::Percent, AttrSource::Strategy));
        let (pct, _) = facts_for_measure(
            &observation_without_a_target("MarginPct", 0.10, 0.12),
            &r,
            &locale(),
        );
        let pct_change = pct
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("a change fact");
        assert!(
            !pct_change.text.contains("20.0%"),
            "a percent OF a percent is the misreading this withholds: {}",
            pct_change.text
        );
        assert!(
            pct_change.text.contains("0.02"),
            "the movement itself is still stated: {}",
            pct_change.text
        );

        // `ratio` is the same sentence for the same reason.
        r.unit = Some(Applied::new(Unit::Ratio, AttrSource::Strategy));
        let (ratio, _) = facts_for_measure(
            &observation_without_a_target("MarginPct", 0.10, 0.12),
            &r,
            &locale(),
        );
        assert!(!ratio
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("a change fact")
            .text
            .contains("20.0%"));

        // POSITIVE CONTROL: a unit with no opinion keeps the clause, so the two
        // arms above are a decision rather than a blanket removal.
        r.unit = Some(Applied::new(Unit::Currency, AttrSource::Strategy));
        let (currency, _) = facts_for_measure(
            &observation_without_a_target("MarginPct", 0.10, 0.12),
            &r,
            &locale(),
        );
        assert!(currency
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("a change fact")
            .text
            .contains("20.0%"));
    }

    #[test]
    fn a_policy_may_reorder_and_withhold_and_the_facts_it_keeps_are_untouched() {
        // TIER D's WHOLE SEAM, and the reason it can ship long before a fact
        // PRODUCER can: reordering cannot put a number in front of a reader that
        // the model did not compute.
        let mut r = resolved("Revenue");
        r.direction = Some(Applied::new(Direction::HigherIsBetter, AttrSource::Strategy));
        // A TARGET, so the run emits both a Change and a Variance fact and there
        // is genuinely an order to change. A one-fact fixture would let a
        // no-op policy pass as a reordering one.
        let mut obs = observation_without_a_target("Revenue", 100.0, 140.0);
        obs.target_value = Some(120.0);
        let (facts, _) = facts_for_measure(&obs, &r, &locale());
        assert!(facts.len() >= 2, "the fixture needs something to reorder: {facts:?}");

        // Reversed, and one dropped.
        let mut order: Vec<String> = facts.iter().map(|f| f.id.clone()).collect();
        order.reverse();
        let dropped = order.pop().expect("more than one fact");

        let after = apply_fact_policy(facts.clone(), &order).expect("a subset in a new order");
        assert_eq!(after.len(), facts.len() - 1);
        assert!(!after.iter().any(|f| f.id == dropped), "the withheld one is gone");

        // WHAT IT KEPT IS BYTE-FOR-BYTE WHAT THE ENGINE BUILT. A policy that
        // could edit a fact would be a producer wearing a policy's clothes.
        for kept in &after {
            let original = facts
                .iter()
                .find(|f| f.id == kept.id)
                .expect("kept ids come from the input");
            assert_eq!(kept, original, "a policy reorders; it does not rewrite");
        }
    }

    #[test]
    fn a_policy_that_invents_a_fact_or_repeats_one_is_refused_by_name() {
        // The guard is a check on the ANSWER, not trust in the policy, which is
        // what makes it total: whatever comes back must be a subset of what went
        // in, matched by id, without duplicates.
        let mut r = resolved("Revenue");
        r.direction = Some(Applied::new(Direction::HigherIsBetter, AttrSource::Strategy));
        let mut obs = observation_without_a_target("Revenue", 100.0, 140.0);
        obs.target_value = Some(120.0);
        let (facts, _) = facts_for_measure(&obs, &r, &locale());
        let real = facts[0].id.clone();

        let invented = apply_fact_policy(facts.clone(), &["change:Margin".to_string()])
            .expect_err("a fact nobody generated must be refused");
        assert!(invented.contains("change:Margin"), "named: {invented}");
        assert!(invented.contains("cannot introduce"), "and the reason: {invented}");

        let twice = apply_fact_policy(facts.clone(), &[real.clone(), real.clone()])
            .expect_err("one fact cannot appear twice in one report");
        assert!(twice.contains(&real), "named: {twice}");

        // POSITIVE CONTROL: the empty policy is legal and means "say nothing
        // about this measure", which is a thing a person may legitimately want.
        assert!(apply_fact_policy(facts, &[]).expect("withholding everything is allowed").is_empty());
    }

    #[test]
    fn suppression_still_happens_after_the_hoist_and_before_any_policy() {
        // THE HOIST MUST NOT HAVE MOVED THE BEHAVIOUR, only the code. A rule's
        // `suppress` list is the DOCUMENT's answer and is applied while the
        // facts are being finished; a policy is a later, separate question.
        let mut r = resolved("Revenue");
        r.direction = Some(Applied::new(Direction::HigherIsBetter, AttrSource::Strategy));
        let (before, _) = facts_for_measure(
            &observation_without_a_target("Revenue", 100.0, 140.0),
            &r,
            &locale(),
        );
        assert!(before.iter().any(|f| f.kind.kind_key() == "change"));

        r.suppressed_kinds
            .insert(crate::insights::strategy::types::SuppressibleFactKind::Change);
        let (after, _) = facts_for_measure(
            &observation_without_a_target("Revenue", 100.0, 140.0),
            &r,
            &locale(),
        );
        assert!(
            !after.iter().any(|f| f.kind.kind_key() == "change"),
            "a suppressed kind never reaches a policy at all: {after:?}"
        );
    }

    #[test]
    fn every_fact_that_used_a_strategy_attribute_carries_its_provenance() {
        let mut r = resolved("Revenue");
        r.direction = Some(Applied::new(
            Direction::HigherIsBetter,
            AttrSource::Kpi("Revenue KPI".to_string()),
        ));
        r.materiality = Some(Applied::new(
            Materiality::Absolute { value: 5.0 },
            AttrSource::Strategy,
        ));
        r.target = Some(Applied::new(
            Target::Literal { value: 150.0 },
            AttrSource::Strategy,
        ));
        r.aggregation = Some(non_additive());

        let mut obs = observation_without_a_target("Revenue", 100.0, 140.0);
        obs.target_value = Some(150.0);
        obs.slices = vec![slice(
            "Product[Category]",
            vec![MemberSeries::new("Gadgets", 100.0, 140.0)],
        )];

        let (facts, _) = facts_for_measure(&obs, &r, &locale());
        let by_kind = |k: &str| {
            facts
                .iter()
                .find(|f| f.kind.kind_key() == k)
                .unwrap_or_else(|| panic!("expected a {} fact, got {:?}", k, kinds_of(&facts)))
        };

        let change = by_kind("change");
        let attrs: BTreeMap<&str, String> = change
            .provenance
            .iter()
            .map(|p| (p.attr.as_str(), attr_source_id(&p.source)))
            .collect();
        assert_eq!(attrs.get("direction").map(String::as_str), Some("kpi:Revenue KPI"));
        assert_eq!(attrs.get("materiality").map(String::as_str), Some("strategy"));

        let variance = by_kind("variance");
        assert!(variance.provenance.iter().any(|p| p.attr == "target"
            && p.source == CoreAttrSource::Strategy));

        // The additivity that DENIED the share claim is named too, or the
        // reader cannot find out why the breakdown has no percentages.
        let member_move = by_kind("memberMove");
        assert!(member_move
            .provenance
            .iter()
            .any(|p| p.attr == "aggregation" && p.value.contains("nonAdditive")));
    }

    #[test]
    fn two_runs_over_the_same_numbers_produce_byte_identical_bundles() {
        let mut r = resolved("Revenue");
        r.direction = Some(Applied::new(Direction::HigherIsBetter, AttrSource::Strategy));
        r.analysis_dimensions = vec![QualifiedColumn::new("Product", "Category")];

        let build = || {
            let mut obs = MeasureObservation {
                measure: "Revenue".to_string(),
                labels: (1..=12).map(|m| format!("2026-{:02}", m)).collect(),
                values: vec![
                    100.0, 104.0, 111.0, 109.0, 118.0, 126.0, 130.0, 141.0, 138.0, 152.0, 160.0,
                    171.0,
                ],
                target_value: Some(150.0),
                ..MeasureObservation::default()
            };
            obs.bands = vec![
                StatusBand {
                    threshold: 0.8,
                    status: "OffTrack".to_string(),
                },
                StatusBand {
                    threshold: 1.0,
                    status: "OnTrack".to_string(),
                },
            ];
            // Two members that moved by the SAME amount, so only the name
            // tie-break can order them.
            obs.slices = vec![slice(
                "Product[Category]",
                vec![
                    MemberSeries::new("Widgets", 80.0, 90.0),
                    MemberSeries::new("Gadgets", 80.0, 90.0),
                ],
            )];
            let (facts, run) = facts_for_measure(&obs, &r, &locale());
            to_wire(&build_run(
                "Sales model",
                &locale(),
                vec![(facts, run)],
                vec!["one note".to_string()],
            ))
        };

        let a = serde_json::to_string(&build()).expect("serializes");
        let b = serde_json::to_string(&build()).expect("serializes");
        assert_eq!(a, b, "two runs over the same numbers must agree byte for byte");
        assert!(a.contains("\"source\":\"model\""));
        assert!(a.contains("\"factsJson\""), "the seam's spelling, not facts_json");

        // FACTS JSON MUST CARRY THE IDS. For a while it did not: it emitted a
        // bare array of kinds while its own doc comment named the Tier-1
        // narrator as its consumer. M6 asks a model for sentences each TAGGED
        // with the facts they cover and then deletes any sentence citing a
        // number its cited facts do not contain — with no ids there is nothing
        // to tag and nothing to check, so the model path could never have been
        // narrated safely at all, and nothing said so because the field had no
        // consumer yet.
        let bundle: serde_json::Value = serde_json::from_str(&a).expect("bundle parses");
        let facts_doc: serde_json::Value =
            serde_json::from_str(bundle["factsJson"].as_str().expect("factsJson is a string"))
                .expect("factsJson parses");
        let records = facts_doc["facts"].as_array().expect("facts is an array");
        assert!(!records.is_empty(), "this fixture must produce facts");
        for record in records {
            let id = record["id"].as_str().unwrap_or_default();
            assert!(!id.is_empty(), "every fact record carries its id: {record}");
            assert!(record["score"].is_number(), "and its score: {record}");
            assert!(record["kind"].is_object(), "and its numbers: {record}");
            assert!(
                record.get("text").is_none(),
                "but never our sentence — a narrator that can read it paraphrases instead: {record}"
            );
        }
    }

    // -- the AST walk ------------------------------------------------------

    fn measure_ref(name: &str) -> bi_engine::Expression {
        bi_engine::Expression::MeasureRef(name.to_string())
    }

    fn binary(
        left: bi_engine::Expression,
        op: bi_engine::ArithmeticOp,
        right: bi_engine::Expression,
    ) -> bi_engine::Expression {
        bi_engine::Expression::BinaryOp {
            left: Box::new(left),
            op,
            right: Box::new(right),
        }
    }

    #[test]
    fn a_difference_of_measures_reads_as_a_signed_term_list() {
        let expression = binary(
            measure_ref("Revenue"),
            bi_engine::ArithmeticOp::Subtract,
            measure_ref("Cost"),
        );
        let none = |_: &str| None;
        assert_eq!(
            driver_shape(&expression, &none),
            Some(DriverShape::Sum(vec![
                ("Revenue".to_string(), 1),
                ("Cost".to_string(), -1)
            ]))
        );
    }

    #[test]
    fn a_ratio_of_two_bare_aggregates_offers_no_decomposition() {
        // `SUM(a) / SUM(b)` has no sub-measure to attribute to, and inventing
        // names for the aggregates would put words in the sentence that appear
        // nowhere in the model.
        let expression = binary(
            bi_engine::Expression::ColumnRef("a".to_string()),
            bi_engine::ArithmeticOp::Divide,
            bi_engine::Expression::ColumnRef("b".to_string()),
        );
        let none = |_: &str| None;
        assert_eq!(driver_shape(&expression, &none), None);
    }

    #[test]
    fn a_cycle_in_the_measure_graph_terminates_instead_of_recursing_forever() {
        // A = B - C, C = A - D. Following C back into A must stop.
        let a = binary(
            measure_ref("B"),
            bi_engine::ArithmeticOp::Subtract,
            measure_ref("C"),
        );
        let lookup = |name: &str| match name {
            "C" => Some(binary(
                measure_ref("A"),
                bi_engine::ArithmeticOp::Subtract,
                measure_ref("D"),
            )),
            "A" => Some(binary(
                measure_ref("B"),
                bi_engine::ArithmeticOp::Subtract,
                measure_ref("C"),
            )),
            _ => None,
        };
        let shape = driver_shape(&a, &lookup).expect("it terminates and still decomposes");
        let DriverShape::Sum(terms) = shape else {
            panic!("expected a sum");
        };
        assert!(terms.iter().any(|(n, _)| n == "B"));
        assert!(terms.len() <= 6, "the walk is bounded: {:?}", terms);
    }

    #[test]
    fn a_suppressed_fact_kind_is_not_emitted() {
        let mut r = resolved("Revenue");
        r.suppressed_kinds = [SuppressibleFactKind::Change].into_iter().collect();
        let (facts, _) = facts_for_measure(&observation_without_a_target("Revenue", 100.0, 200.0), &r, &locale());
        assert!(!kinds_of(&facts).contains(&"change".to_string()));
    }

    #[test]
    fn a_series_fact_kind_the_suppress_vocabulary_has_no_word_for_is_simply_unsuppressible() {
        // The `Series` arm looks a wire key UP rather than carrying its own list
        // of three. A `core/insights` fact a model run never wraps - `outliers`
        // is the one that started all this - therefore reports NO suppressible
        // kind, instead of a plausible-looking key nothing matches.
        let unwrapped = ModelFactKind::Series {
            inner: FactKind::Duplicates {
                rows: 3,
                example_row: 7,
            },
        };
        assert_eq!(unwrapped.kind_key(), "duplicates");
        assert_eq!(unwrapped.suppressible_kind(), None);
        assert_eq!(
            ModelFactKind::Series {
                inner: FactKind::Trend {
                    subject: Subject::measure("Revenue"),
                    slope_per_step: 1.0,
                    r2: 0.9,
                    pct_change: 0.2,
                    first: 100.0,
                    last: 120.0,
                    n: 12,
                    direction: insights::types::Direction::Rising,
                },
            }
            .suppressible_kind(),
            Some(SuppressibleFactKind::Trend),
            "and the three a run really does wrap are named"
        );
    }

    /// Two sets of period values that between them fire every builder in
    /// `SERIES_BUILDERS`.
    ///
    /// A ramp trends and (because binary segmentation splits a straight line
    /// too) also change-points; a sixty-point sine over a twelve-period cycle is
    /// the seasonality case. A fourth builder that neither of these fires is not
    /// a hole the sample list can hide - `one_of_every_fact_kind_a_run_can_emit`
    /// asserts every builder produced something and names the one that did not.
    fn probe_values() -> Vec<Vec<f64>> {
        let ramp: Vec<f64> = (0..30).map(|i| 100.0 + 5.0 * i as f64).collect();
        let cycle: Vec<f64> = (0..60)
            .map(|i| 100.0 + 10.0 * (std::f64::consts::TAU * i as f64 / 12.0).sin())
            .collect();
        vec![ramp, cycle]
    }

    /// The labels `facts_for_measure` would be handed beside those values.
    fn probe_labels(values: &[f64]) -> Vec<String> {
        (1..=values.len()).map(|i| format!("P{i}")).collect()
    }

    /// A fieldless mirror of `ModelFactKind`, so "every variant a run can emit"
    /// is a SET rather than a hand-counted array of flags.
    ///
    /// WHAT THE COMPILER PROVES AND WHAT IT DOES NOT, stated because the
    /// previous spelling implied more than it delivered. `Variant::of` is an
    /// exhaustive match on `ModelFactKind`, so a seventh variant cannot compile
    /// until it is named here; `ALL` is then the one hand-written list left, and
    /// a variant named in `of` but missing from `ALL` is NOT caught. The old
    /// spelling was `let mut seen = [false; 6]`, where the same omission could
    /// be answered by editing a number - and where an arm mapped to an
    /// out-of-range index panicked instead of failing an assertion that says
    /// what is wrong.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    enum Variant {
        Change,
        Variance,
        DefinitionalDriver,
        Contribution,
        MemberMove,
        Series,
    }

    impl Variant {
        const ALL: &'static [Variant] = &[
            Variant::Change,
            Variant::Variance,
            Variant::DefinitionalDriver,
            Variant::Contribution,
            Variant::MemberMove,
            Variant::Series,
        ];

        fn of(kind: &ModelFactKind) -> Variant {
            match kind {
                ModelFactKind::Change { .. } => Variant::Change,
                ModelFactKind::Variance { .. } => Variant::Variance,
                ModelFactKind::DefinitionalDriver { .. } => Variant::DefinitionalDriver,
                ModelFactKind::Contribution { .. } => Variant::Contribution,
                ModelFactKind::MemberMove { .. } => Variant::MemberMove,
                ModelFactKind::Series { .. } => Variant::Series,
            }
        }
    }

    /// One fact of every kind a run can emit, PRODUCED BY A RUN.
    ///
    /// NOTHING IN THIS LIST IS HAND-TYPED. The five non-`Series` kinds used to
    /// be literals sitting under a header that said the list was derived - the
    /// header describing the three `Series` entries and quietly covering for the
    /// five beside them. A hand-typed `Variance` literal is a claim about
    /// `facts_for_measure` that nothing checks: the branch could stop firing, or
    /// start firing on different terms, and this list - the input to the guard
    /// that exists to catch exactly that - would go on describing the old shape.
    ///
    /// So the samples are now whatever `facts_for_measure` returns for an
    /// observation built to fire every branch it has: two periods and a target
    /// for `Change` and `Variance`, a `Sum` driver for `DefinitionalDriver`, one
    /// slice on an additive dimension for `Contribution` and one on a
    /// semi-additive dimension for `MemberMove`, over the two series
    /// `probe_values` supplies. A branch that stops firing is a failure of the
    /// coverage check in the test below, which names the variant that went
    /// missing.
    fn one_of_every_fact_kind_a_run_can_emit() -> Vec<ModelFactKind> {
        // `Customer[Segment]` is semi-additive and `Product[Category]` is not,
        // so the two slices below take the two different arms of
        // `contributions_for`.
        let resolved = ResolvedMeasure {
            measure: "Revenue".to_string(),
            direction: Some(Applied::new(Direction::HigherIsBetter, AttrSource::Strategy)),
            target: Some(Applied::new(
                Target::Literal { value: 150.0 },
                AttrSource::Strategy,
            )),
            aggregation: Some(Applied::new(
                AggregationSpec {
                    default: Additivity::Additive,
                    by_dimension: BTreeMap::from([(
                        "Customer[Segment]".to_string(),
                        Additivity::LastValue,
                    )]),
                },
                AttrSource::Strategy,
            )),
            ..ResolvedMeasure::default()
        };

        let mut out: Vec<ModelFactKind> = Vec::new();
        for values in probe_values() {
            let observation = MeasureObservation {
                measure: "Revenue".to_string(),
                labels: probe_labels(&values),
                values,
                target_value: Some(150.0),
                slices: vec![
                    slice(
                        "Product[Category]",
                        vec![MemberSeries::new("Gadgets", 100.0, 140.0)],
                    ),
                    slice(
                        "Customer[Segment]",
                        vec![MemberSeries::new("Enterprise", 100.0, 140.0)],
                    ),
                ],
                driver: Some(DriverInput::Sum {
                    terms: vec![
                        DriverTerm {
                            measure: "Units".to_string(),
                            coefficient: 1.0,
                            first: 60.0,
                            last: 64.0,
                        },
                        DriverTerm {
                            measure: "Returns".to_string(),
                            coefficient: -1.0,
                            first: 10.0,
                            last: 11.0,
                        },
                    ],
                }),
                ..MeasureObservation::default()
            };
            let (facts, _) = facts_for_measure(&observation, &resolved, &locale());
            out.extend(facts.into_iter().map(|f| f.kind));
        }

        // WHICH BUILDER WENT SILENT, which neither check below can say. A
        // `Series` fact carries the wire key of the fact it wraps and not the
        // name of the builder that made it, so a seasonality builder that
        // stopped firing leaves the `Series` variant covered by the trend facts:
        // the variant check stays green and the kind-key diff fails with
        // "listed-only [seasonality]", which points at the vocabulary file
        // rather than at the probe series that stopped exercising it. This
        // assertion fires first and names the builder.
        for (name, build) in SERIES_BUILDERS {
            let produced: Vec<FactKind> = probe_values()
                .iter()
                .flat_map(|values| {
                    build(
                        &timeseries::Series::new(
                            Subject::measure("Revenue"),
                            &probe_labels(values),
                            values,
                        ),
                        // No cadence: the probe is asking whether each builder
                        // FIRES at all, and a preferred cycle can only change
                        // which lag one of them picks.
                        None,
                    )
                })
                .collect();
            assert!(
                !produced.is_empty(),
                "no probe series fires the '{name}' builder, so the suppressibility diff below \
                 would silently not cover it. Add a series to `probe_values` that does."
            );
        }
        out
    }

    #[test]
    fn every_fact_kind_a_run_can_emit_is_spelled_in_the_suppressible_list() {
        // THE ONLY WAY A `suppress` ENTRY CAN FAIL IS BY SPELLING, and the list
        // a person copies the spelling from lives in the strategy document's
        // vocabulary file while the spellings themselves are produced HERE. That
        // is a drift waiting to happen, so it is diffed in BOTH directions: a
        // kind the engine emits and the list does not name cannot be suppressed
        // at all, and a name in the list that no fact carries is a spelling the
        // validator blesses and the engine then ignores.
        let samples = one_of_every_fact_kind_a_run_can_emit();

        // THE SAMPLES COME OUT OF A RUN, so this is a statement about the run
        // and not about a list somebody maintained: a variant missing here means
        // the observation above no longer fires the branch that emits it, and
        // that kind is therefore not diffed against the vocabulary at all.
        let seen: BTreeSet<Variant> = samples.iter().map(Variant::of).collect();
        let missing: Vec<Variant> = Variant::ALL
            .iter()
            .copied()
            .filter(|v| !seen.contains(v))
            .collect();
        assert!(
            missing.is_empty(),
            "the run in `one_of_every_fact_kind_a_run_can_emit` emits no {missing:?} fact, so \
             that kind is not diffed against the suppressible vocabulary below. Give the \
             observation whatever fires that branch"
        );

        let emitted: BTreeSet<String> = samples.iter().map(|k| k.kind_key()).collect();
        let listed: BTreeSet<String> = SuppressibleFactKind::ALL
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();
        assert_eq!(
            emitted, listed,
            "the suppressible vocabulary and the kinds a run emits have drifted; \
             emitted-only {:?}, listed-only {:?}",
            emitted.difference(&listed).collect::<Vec<_>>(),
            listed.difference(&emitted).collect::<Vec<_>>()
        );

        // ...and the same diff through the TYPED accessor, which is what the
        // engine actually filters on. `kind_key` is the wire spelling and
        // `suppressible_kind` is the enum; if they ever disagree, a `suppress`
        // entry the validator accepts would withhold nothing - which is the
        // whole defect the type was introduced to make impossible.
        let typed: BTreeSet<String> = samples
            .iter()
            .map(|k| {
                k.suppressible_kind()
                    .unwrap_or_else(|| panic!("{} is emitted and must be suppressible", k.kind_key()))
                    .as_str()
                    .to_string()
            })
            .collect();
        assert_eq!(typed, emitted, "kind_key and suppressible_kind disagree");
    }

    #[test]
    fn a_band_target_decides_favourability_from_where_the_value_landed() {
        // THE BAND HAD NO PRODUCTIVE CONSUMER. `favourability_of` reads a delta
        // and correctly declines a band; the variance fact that was supposed to
        // answer instead is never built for a band target, so a `targetBand`
        // measure shipped every fact with no favourability at all. The landed
        // value is what can decide it, and every fact below has one.
        let mut r = resolved("Quantity");
        r.direction = Some(Applied::new(Direction::TargetBand, AttrSource::Strategy));
        r.target = Some(Applied::new(Target::band(90.0, 140.0), AttrSource::Strategy));

        let (facts, run) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 120.0), &r, &locale());
        assert_eq!(
            run.favourability,
            Some(Favourability::Better),
            "120 is inside [90, 140]: {:?}",
            kinds_of(&facts)
        );

        let (_, out) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 160.0), &r, &locale());
        assert_eq!(out.favourability, Some(Favourability::Worse), "160 is above it");

        // ...and the inclusivity of the end is spent right here: the same value
        // on the same band, judged the other way by one flag.
        r.target = Some(Applied::new(
            Target::Band {
                low: 90.0,
                high: 140.0,
                low_inclusive: true,
                high_inclusive: false,
            },
            AttrSource::Strategy,
        ));
        let (_, edge) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 140.0), &r, &locale());
        assert_eq!(edge.favourability, Some(Favourability::Worse));
        r.target = Some(Applied::new(Target::band(90.0, 140.0), AttrSource::Strategy));
        let (_, edge) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 140.0), &r, &locale());
        assert_eq!(edge.favourability, Some(Favourability::Better));

        // A WITHHELD DIRECTION STILL WINS. Rule 4 outranks the band, or a
        // suppression could be walked around by declaring one.
        r.suppressions = vec![Suppression {
            attribute: Attribute::Direction,
            rule: "r1".into(),
            reason: "the aggregate spans two directions".into(),
        }];
        let (_, withheld) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 120.0), &r, &locale());
        assert_eq!(withheld.favourability, None);
    }

    #[test]
    fn a_band_fact_says_which_side_the_value_missed_on_and_quotes_the_band() {
        // "which is worse" does not tell a warehouse manager whether to ship
        // more or ship less, and the band that decided it appeared NOWHERE in
        // the output: a band target yields no variance fact at all, and the
        // Change fact's provenance carried direction and materiality only.
        let mut r = resolved("Quantity");
        r.direction = Some(Applied::new(Direction::TargetBand, AttrSource::Strategy));
        r.target = Some(Applied::new(Target::band(90.0, 140.0), AttrSource::Strategy));

        let (facts, _) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 160.0), &r, &locale());
        let change = facts
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("a material movement produces a change fact");
        assert!(
            change.text.contains("is above the band [90, 140]"),
            "the sentence must name the side and the band: {}",
            change.text
        );
        // ...and the band reaches the why-panel too, sourced like every other
        // applied attribute.
        let target = change
            .provenance
            .iter()
            .find(|p| p.attr == "target")
            .expect("the band decided this fact and must be in its provenance");
        assert_eq!(target.value, "band [90, 140]");

        // The other side, and the inside case - so "above" is read off the
        // value rather than hard-coded.
        let (below, _) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 40.0), &r, &locale());
        assert!(
            below
                .iter()
                .any(|f| f.text.contains("is below the band [90, 140]")),
            "{:?}",
            below.iter().map(|f| f.text.as_str()).collect::<Vec<_>>()
        );
        let (inside, _) = facts_for_measure(&observation_without_a_target("Quantity", 90.0, 130.0), &r, &locale());
        assert!(inside
            .iter()
            .any(|f| f.text.contains("is inside the band [90, 140]")));

        // NO OTHER DIRECTION GAINS A CLAUSE. A band is the only thing that can
        // produce one, so an ordinary measure's sentence is untouched.
        let plain = resolved("Revenue");
        let (facts, _) = facts_for_measure(&observation_without_a_target("Revenue", 100.0, 120.0), &plain, &locale());
        assert!(
            facts.iter().all(|f| !f.text.contains("the band")),
            "{:?}",
            facts.iter().map(|f| f.text.as_str()).collect::<Vec<_>>()
        );

        // ...and a WITHHELD direction carries no band clause either, or Rule 4
        // could be walked around by reading the sentence.
        r.suppressions = vec![Suppression {
            attribute: Attribute::Direction,
            rule: "r1".into(),
            reason: "the aggregate spans two directions".into(),
        }];
        let (facts, _) = facts_for_measure(&observation_without_a_target("Quantity", 100.0, 160.0), &r, &locale());
        assert!(facts.iter().all(|f| !f.text.contains("the band")));
    }

    #[test]
    fn a_dimension_that_is_both_an_analysis_axis_and_forbidden_says_so_instead_of_vanishing() {
        // The document contradicts itself and the PROHIBITION wins, which is
        // fine; what was not fine is that the breakdown simply was not there and
        // nothing said why. `validate` refuses such a document, so this is the
        // note for a hand-edited file that reached the run path anyway.
        let dimension = QualifiedColumn::new("Product", "Category");
        let mut r = resolved("Revenue");
        r.analysis_dimensions = vec![dimension.clone()];
        r.never_slice_by = vec![dimension.clone()];
        let facts = ModelFacts {
            tables: BTreeMap::from([(
                "Product".to_string(),
                TableFacts {
                    columns: BTreeSet::from(["Category".to_string()]),
                    ..Default::default()
                },
            )]),
            ..Default::default()
        };
        let plan = plan_dimensions(&r, &facts, None);
        assert!(plan.dimensions.is_empty(), "the prohibition wins");
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        assert!(
            plan.notes[0].contains("Product[Category]") && plan.notes[0].contains("forbids"),
            "{}",
            plan.notes[0]
        );
    }

    #[test]
    fn an_aggregation_with_no_entry_for_this_dimension_does_not_claim_one() {
        // "lastValue over Product" is a PER-DIMENSION claim. The provenance line
        // printed it for a spec whose `byDimension` was empty, attributing to
        // the document a statement it never made - about a rollup that has no
        // meaning along that dimension. It now says what the document said.
        //
        // The two lookups also used to disagree: the share GATE tried all three
        // key spellings while the provenance line tried only `Table[Column]`, so
        // a `byDimension` keyed on the bare table denied the share and then
        // printed the default as its reason.
        let dimension = QualifiedColumn::new("Product", "Category");
        let mut r = resolved("Revenue");
        r.aggregation = Some(non_additive());
        let mut obs = observation_without_a_target("Revenue", 100.0, 140.0);
        obs.slices = vec![slice(
            "Product[Category]",
            vec![MemberSeries::new("Gadgets", 100.0, 140.0)],
        )];

        let (facts, _) = facts_for_measure(&obs, &r, &locale());
        let aggregation = facts
            .iter()
            .flat_map(|f| f.provenance.iter())
            .find(|p| p.attr == "aggregation")
            .expect("the additivity that denied the share is named");
        assert_eq!(
            aggregation.value, "nonAdditive",
            "a model-wide default is reported as one, with no dimension attached"
        );

        // The bare-TABLE spelling: `is_additive_over` honours it, so the
        // provenance must name it too rather than falling back to the default.
        r.aggregation = Some(Applied::new(
            AggregationSpec {
                default: Additivity::Additive,
                by_dimension: BTreeMap::from([("Product".to_string(), Additivity::LastValue)]),
            },
            AttrSource::Strategy,
        ));
        assert!(!is_additive_over(&r, &dimension), "the bare table key is honoured");
        let (facts, _) = facts_for_measure(&obs, &r, &locale());
        let aggregation = facts
            .iter()
            .flat_map(|f| f.provenance.iter())
            .find(|p| p.attr == "aggregation")
            .expect("an aggregation is named");
        assert_eq!(aggregation.value, "lastValue over Product[Category]");
    }

    #[test]
    fn a_kpi_band_is_read_as_a_floor_even_when_the_model_lists_it_high_to_low() {
        let bands = vec![
            StatusBand {
                threshold: 1.0,
                status: "OnTrack".to_string(),
            },
            StatusBand {
                threshold: 0.8,
                status: "AtRisk".to_string(),
            },
            StatusBand {
                threshold: 0.0,
                status: "OffTrack".to_string(),
            },
        ];
        assert_eq!(band_for(&bands, 1.2).as_deref(), Some("OnTrack"));
        assert_eq!(band_for(&bands, 0.9).as_deref(), Some("AtRisk"));
        assert_eq!(band_for(&bands, 0.1).as_deref(), Some("OffTrack"));
    }

    #[test]

    fn a_rule_that_only_reaches_some_members_is_still_named_on_the_fact_it_touched() {
        // Guards the wiring between resolve.rs and this file: a rule that set
        // the direction must reach `provenance` as `rule:<id>`, not as
        // "strategy".
        let doc = StrategyDoc {
            version: 1,
            rules: vec![Rule {
                id: "nordics-floor".to_string(),
                measure: "Revenue".to_string(),
                scope: Scope::from([(
                    QualifiedColumn::new("Product", "Category"),
                    ScopeValue::Members(vec!["Gadgets".to_string()]),
                )]),
                set: crate::insights::strategy::AttributeSet {
                    direction: Some(Direction::LowerIsBetter),
                    ..Default::default()
                },
                note: None,
            }],
            ..StrategyDoc::default()
        };
        let point = crate::insights::strategy::ScopePoint::fixing([(
            QualifiedColumn::new("Product", "Category"),
            "Gadgets",
        )]);
        let r = crate::insights::strategy::resolve(&star_facts(), &doc, "Revenue", &point);
        let (facts, _) = facts_for_measure(&observation_without_a_target("Revenue", 100.0, 130.0), &r, &locale());
        let change = facts
            .iter()
            .find(|f| f.kind.kind_key() == "change")
            .expect("a 30% rise clears the default gate");
        assert!(change
            .provenance
            .iter()
            .any(|p| p.attr == "direction"
                && attr_source_id(&p.source) == "rule:nordics-floor"));
    }

    // -----------------------------------------------------------------------
    // The band invariant: an explanation never outranks what it explains.
    // -----------------------------------------------------------------------

    /// A bare `ResolvedMeasure` with no declared priority or rank weight, so
    /// `score_for` returns the BAND alone — which is what the invariant is
    /// about (priority and weight are per measure and cancel between a
    /// measure's own facts).
    fn unweighted_measure() -> crate::insights::strategy::resolve::ResolvedMeasure {
        crate::insights::strategy::resolve::ResolvedMeasure {
            measure: "Revenue".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn a_movement_always_outranks_its_own_explanation() {
        // FOUND LIVE: with the old bands (change 0.60 + 0.25*pct against
        // contribution 0.50 + 0.20*explained) a fully-explained contribution
        // beat its own change fact for ANY movement under 40%, so the 12-fact
        // budget kept three breakdowns of a fall it never stated.
        let m = unweighted_measure();
        let change = |pct: f64| {
            score_for(
                &ModelFactKind::Change {
                    measure: "Revenue".into(),
                    first_label: "2025-11".into(),
                    last_label: "2025-12".into(),
                    first: 1.0,
                    last: 1.0,
                    delta: -1.0,
                    pct: Some(pct),
                    favourability: None,
                    band: None,
                },
                &m,
            )
        };
        let contribution = |explained: f64| {
            score_for(
                &ModelFactKind::Contribution {
                    measure: "Revenue".into(),
                    dimension: "Product[Category]".into(),
                    total_delta: -1.0,
                    members: Vec::new(),
                    others: None,
                    explained,
                },
                &m,
            )
        };

        // The live case: a 10.4% fall, fully explained. The headline must win.
        assert!(
            change(0.1036) > contribution(1.0),
            "a 10% movement must outrank its own fully-explained breakdown: {} vs {}",
            change(0.1036),
            contribution(1.0),
        );

        // And at every magnitude, including no movement at all.
        for pct in [0.0, 0.001, 0.05, 0.1036, 0.25, 0.39, 0.40, 0.75, 1.0] {
            for explained in [0.5, 0.75, 0.9, 1.0] {
                assert!(
                    change(pct) > contribution(explained),
                    "change({pct}) = {} must outrank contribution({explained}) = {}",
                    change(pct),
                    contribution(explained),
                );
            }
        }
    }

    #[test]
    fn a_variance_still_leads_a_change_of_the_same_size() {
        // The pre-existing ordering the fix must not invert.
        let m = unweighted_measure();
        for pct in [0.0, 0.1, 0.5, 1.0] {
            let variance = score_for(
                &ModelFactKind::Variance {
                    measure: "Revenue".into(),
                    period_label: "2025-12".into(),
                    value: 1.0,
                    target: 2.0,
                    delta: -1.0,
                    pct: Some(pct),
                    status: None,
                    favourability: None,
                    band: None,
                },
                &m,
            );
            let change = score_for(
                &ModelFactKind::Change {
                    measure: "Revenue".into(),
                    first_label: "2025-11".into(),
                    last_label: "2025-12".into(),
                    first: 1.0,
                    last: 1.0,
                    delta: -1.0,
                    pct: Some(pct),
                    favourability: None,
                    band: None,
                },
                &m,
            );
            assert!(variance > change, "variance {variance} must lead change {change} at pct {pct}");
        }
    }

}
