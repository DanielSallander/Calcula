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

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use engine::LocaleSettings;
use insights::narrate::number;
use insights::types::{AppliedAttr, AttrSource as CoreAttrSource, FactKind, Subject};
use insights::{narrate, timeseries};

use super::strategy::resolve::CalendarSource;
use super::strategy::{
    Additivity, AggregationSpec, Attribute, AttrSource, Direction, Materiality, ModelFacts,
    QualifiedColumn, ResolvedMeasure, StrategyDoc, Target,
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
    },
    Variance {
        measure: String,
        period_label: String,
        value: f64,
        target: f64,
        delta: f64,
        pct: Option<f64>,
        /// The KPI band the value/target ratio falls in, when the model bands it.
        status: Option<String>,
        favourability: Option<Favourability>,
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
/// `TargetBand` is deliberately absent: "good means inside a band" cannot be
/// decided from a delta, only from where the value LANDED, so a change fact
/// under it carries no favourability and the variance fact answers instead.
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
/// THE BAND HAD NO PRODUCTIVE CONSUMER AT ALL. `favourability_of` reads a delta
/// and correctly declines the band; the comment above it says "the variance fact
/// answers instead", and that was not true - a band target resolves to no
/// `target_value`, so no variance fact is ever built and the band decided
/// nothing anywhere in a shipped run. A caller that HAS the landed value (every
/// fact below does) can decide it here, and the bounds' inclusivity is spent on
/// exactly this call.
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
        let band = resolved.target.as_ref().and_then(|t| t.value.as_band());
        // A band direction with no band, or no observed value, still carries no
        // judgement — and validate.rs refuses the first of those outright.
        return match (band, value) {
            (Some(band), Some(v)) => Some(if band.contains(v) {
                Favourability::Better
            } else {
                Favourability::Worse
            }),
            _ => None,
        };
    }
    resolved_favourability(resolved, delta)
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
        if on_the_calendar && facts.calendar_source == Some(CalendarSource::Inferred) {
            notes.push(format!(
                "Time runs along {}, and nobody said it should: no table in this model is marked \
                 as its date table, so {} was guessed to be the calendar from its column names. \
                 Every trend, change point and seasonality claim below rests on that guess. Mark \
                 the date table in the Model Editor to make it a decision.",
                axis, axis.table
            ));
        }
    }
    TimeAxisPlan { axis, notes }
}

/// The axis alone, for a caller that has no `notes` to put the provenance in.
///
/// WHAT THIS DROPS. `plan_time_axis` is the whole function; this is the half of
/// it that answers "which column", and it silently discards the half that says
/// where the calendar came from. `run_model_insights` in `model_commands.rs` is
/// the one production caller and it HAS a `notes` vector two lines above the
/// call — it should take the plan and `notes.extend(plan.notes)`, exactly as it
/// already does for `plan_dimensions`. Until it does, a guessed calendar drives
/// a real report without saying so.
pub fn choose_time_axis(
    doc: &StrategyDoc,
    facts: &ModelFacts,
    date_columns: &[QualifiedColumn],
) -> Option<QualifiedColumn> {
    plan_time_axis(doc, facts, date_columns).axis
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
            // A deliberate exclusion, not a failure. It is named in the
            // document the reader can open, so it needs no note.
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

fn with_pct(pct: Option<f64>, locale: &LocaleSettings) -> String {
    match pct {
        Some(p) => format!(" ({})", number::signed_pct(p, locale)),
        None => String::new(),
    }
}

/// One sentence per fact, in the reader's number formatting.
pub fn narrate_fact(kind: &ModelFactKind, locale: &LocaleSettings) -> String {
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
        } => {
            let judgement = match favourability {
                Some(f) => format!(", which is {}", f.word()),
                // A withheld direction says so, rather than leaving the reader
                // to assume the number speaks for itself.
                None => ", with no favourability claim".to_string(),
            };
            format!(
                "{} {} from {} in {} to {} in {}{}{}.",
                measure,
                moved(*delta, locale),
                number::num(*first, locale),
                first_label,
                number::num(*last, locale),
                last_label,
                with_pct(*pct, locale),
                judgement
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
        } => {
            let band = match status {
                Some(s) => format!(" Status: {}.", s),
                None => String::new(),
            };
            let judgement = match favourability {
                Some(f) => format!(", which is {}", f.word()),
                None => ", with no favourability claim".to_string(),
            };
            format!(
                "{} was {} in {} against a target of {}, {} {}{}{}.{}",
                measure,
                number::num(*value, locale),
                period_label,
                number::num(*target, locale),
                if *delta >= 0.0 { "over by" } else { "under by" },
                number::num(delta.abs(), locale),
                with_pct(*pct, locale),
                judgement,
                band
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
    let base = match kind {
        ModelFactKind::Variance { pct, .. } => 0.70 + 0.25 * magnitude(*pct, 0.2),
        ModelFactKind::Change { pct, .. } => 0.60 + 0.25 * magnitude(*pct, 0.2),
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
            run.favourability = favourability;
            let mut provenance = direction_provenance(resolved);
            if let Some(m) = resolved.materiality.as_ref() {
                provenance.push(attr(
                    "materiality",
                    materiality_word(&m.value),
                    &m.source,
                ));
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
                },
                provenance,
                vec![series_evidence.clone()],
            ));
        }
    }

    // --- Variance against the resolved target -------------------------------
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
            run.driver = Some(narrate_fact(&kind, locale));
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
    let mut series_facts: Vec<FactKind> = Vec::new();
    series_facts.extend(timeseries::trend_fact(&series));
    series_facts.extend(timeseries::change_point_facts(&series));
    series_facts.extend(timeseries::seasonality_fact(&series));
    for inner in series_facts {
        kinds.push((
            ModelFactKind::Series { inner },
            Vec::new(),
            vec![series_evidence.clone()],
        ));
    }

    // --- Suppression, scoring, narration ------------------------------------
    let mut facts: Vec<ModelFact> = Vec::new();
    for (kind, provenance, evidence) in kinds {
        if resolved.suppressed_kinds.contains(&kind.kind_key()) {
            continue;
        }
        let text = narrate_fact(&kind, locale);
        facts.push(ModelFact {
            id: kind.id(),
            score: score_for(&kind, resolved),
            kind,
            text,
            evidence,
            provenance,
        });
    }
    (facts, run)
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
fn facts_json(run: &ModelRun) -> String {
    let kinds: Vec<&ModelFactKind> = run.facts.iter().map(|f| &f.kind).collect();
    serde_json::to_string(&kinds).unwrap_or_else(|_| "[]".to_string())
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
        Suppression, TableFacts, SUPPRESSIBLE_FACT_KINDS,
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

    /// Two periods of a measure, with no dimensions and no driver.
    fn observation(measure: &str, first: f64, last: f64) -> MeasureObservation {
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
            let text = narrate_fact(fact, &locale());
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
        assert!(narrate_fact(&facts[0], &locale()).contains("of the total"));
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
        let (facts, _) = facts_for_measure(&observation("Revenue", 100.0, 102.0), &r, &locale());
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
        let (facts, run) = facts_for_measure(&observation("Revenue", 100.0, 112.0), &r, &locale());
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

        let (facts, run) = facts_for_measure(&observation("Returns", 100.0, 130.0), &r, &locale());
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
        let (facts, _) = facts_for_measure(&observation("Cost", 100.0, 80.0), &better, &locale());
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
        let mut obs = observation("Revenue", 100.0, 140.0);
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
        let mut facts = star_facts();
        facts.date_table = None;
        let doc = StrategyDoc {
            version: 1,
            ..StrategyDoc::default()
        };
        assert_eq!(choose_time_axis(&doc, &facts, &[]), None);

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
            choose_time_axis(&doc, &star_facts(), &[QualifiedColumn::new("Date", "Date")]),
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

        let mut obs = observation("Revenue", 100.0, 140.0);
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
        r.suppressed_kinds = ["change".to_string()].into_iter().collect();
        let (facts, _) = facts_for_measure(&observation("Revenue", 100.0, 200.0), &r, &locale());
        assert!(!kinds_of(&facts).contains(&"change".to_string()));
    }

    /// One fact of every kind a run can emit.
    ///
    /// The three `Series` entries are exactly the three `facts_for_measure`
    /// builds - trend, change point, seasonality - and no others: nothing else
    /// in this file wraps a `FactKind`, so nothing else can reach a `suppress`
    /// list.
    fn one_of_every_fact_kind_a_run_can_emit() -> Vec<ModelFactKind> {
        let series = |inner: FactKind| ModelFactKind::Series { inner };
        vec![
            ModelFactKind::Change {
                measure: "Revenue".into(),
                first_label: "Jan".into(),
                last_label: "Feb".into(),
                first: 100.0,
                last: 120.0,
                delta: 20.0,
                pct: Some(0.2),
                favourability: None,
            },
            ModelFactKind::Variance {
                measure: "Revenue".into(),
                period_label: "Feb".into(),
                value: 120.0,
                target: 150.0,
                delta: -30.0,
                pct: Some(-0.2),
                status: None,
                favourability: None,
            },
            ModelFactKind::DefinitionalDriver {
                measure: "Margin".into(),
                kind: DecompositionKind::Difference,
                total_delta: 20.0,
                parts: Vec::new(),
                residual: 0.0,
            },
            ModelFactKind::Contribution {
                measure: "Revenue".into(),
                dimension: "Product[Category]".into(),
                total_delta: 20.0,
                members: Vec::new(),
                others: None,
                explained: 1.0,
            },
            ModelFactKind::MemberMove {
                measure: "Revenue".into(),
                dimension: "Product[Category]".into(),
                member: "Gadgets".into(),
                first: 10.0,
                last: 12.0,
                delta: 2.0,
            },
            series(FactKind::Trend {
                subject: Subject::measure("Revenue"),
                slope_per_step: 1.0,
                r2: 0.9,
                pct_change: 0.2,
                first: 100.0,
                last: 120.0,
                n: 12,
                direction: insights::types::Direction::Rising,
            }),
            series(FactKind::ChangePoint {
                subject: Subject::measure("Revenue"),
                at_label: "Mar".into(),
                at_index: 2,
                before_mean: 100.0,
                after_mean: 130.0,
                shift_sd: 2.0,
            }),
            series(FactKind::Seasonality {
                subject: Subject::measure("Revenue"),
                lag: 12,
                acf: 0.8,
            }),
        ]
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

        // Adding a `ModelFactKind` variant fails to compile this match, and the
        // `seen` array below then fails until a sample for it exists - which is
        // what keeps the list above from silently going stale.
        let mut seen = [false; 6];
        for kind in &samples {
            let variant = match kind {
                ModelFactKind::Change { .. } => 0,
                ModelFactKind::Variance { .. } => 1,
                ModelFactKind::DefinitionalDriver { .. } => 2,
                ModelFactKind::Contribution { .. } => 3,
                ModelFactKind::MemberMove { .. } => 4,
                ModelFactKind::Series { .. } => 5,
            };
            seen[variant] = true;
        }
        assert!(
            seen.iter().all(|s| *s),
            "every ModelFactKind variant needs a sample here: {seen:?}"
        );

        let emitted: BTreeSet<String> = samples.iter().map(|k| k.kind_key()).collect();
        let listed: BTreeSet<String> = SUPPRESSIBLE_FACT_KINDS
            .iter()
            .map(|k| (*k).to_string())
            .collect();
        assert_eq!(
            emitted, listed,
            "the suppressible list and the kinds a run emits have drifted; \
             emitted-only {:?}, listed-only {:?}",
            emitted.difference(&listed).collect::<Vec<_>>(),
            listed.difference(&emitted).collect::<Vec<_>>()
        );
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

        let (facts, run) = facts_for_measure(&observation("Quantity", 100.0, 120.0), &r, &locale());
        assert_eq!(
            run.favourability,
            Some(Favourability::Better),
            "120 is inside [90, 140]: {:?}",
            kinds_of(&facts)
        );

        let (_, out) = facts_for_measure(&observation("Quantity", 100.0, 160.0), &r, &locale());
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
        let (_, edge) = facts_for_measure(&observation("Quantity", 100.0, 140.0), &r, &locale());
        assert_eq!(edge.favourability, Some(Favourability::Worse));
        r.target = Some(Applied::new(Target::band(90.0, 140.0), AttrSource::Strategy));
        let (_, edge) = facts_for_measure(&observation("Quantity", 100.0, 140.0), &r, &locale());
        assert_eq!(edge.favourability, Some(Favourability::Better));

        // A WITHHELD DIRECTION STILL WINS. Rule 4 outranks the band, or a
        // suppression could be walked around by declaring one.
        r.suppressions = vec![Suppression {
            attribute: Attribute::Direction,
            rule: "r1".into(),
            reason: "the aggregate spans two directions".into(),
        }];
        let (_, withheld) = facts_for_measure(&observation("Quantity", 100.0, 120.0), &r, &locale());
        assert_eq!(withheld.favourability, None);
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
        let mut obs = observation("Revenue", 100.0, 140.0);
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
        let (facts, _) = facts_for_measure(&observation("Revenue", 100.0, 130.0), &r, &locale());
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
}
