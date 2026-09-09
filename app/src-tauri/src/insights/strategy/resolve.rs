//! FILENAME: app/src-tauri/src/insights/strategy/resolve.rs
// PURPOSE: Layer the strategy document down onto ONE measure at ONE point of the
//          analysis space, attribute by attribute, recording where each answer
//          came from.
// CONTEXT: Three properties here are the whole design, and each of them was
//          chosen against an obvious cheaper version that is wrong.
//
//          (1) LAYERING IS PER ATTRIBUTE, NOT PER RECORD. Base (model-derived) ->
//          the measure entry -> rules, most specific wins - but a rule that sets
//          only `direction` must leave `materiality` and `aggregation` exactly as
//          inherited. Whole-record override is the version everyone writes first,
//          and it silently drops the inherited materiality of every measure any
//          rule touches, so facts start appearing for movements the business
//          already said were noise.
//
//          (2) EVERY APPLIED ATTRIBUTE CARRIES ITS PROVENANCE. `Applied<T>` is a
//          value plus an `AttrSource`. Without it there is no way to answer "why
//          does this say worse", and the inline tests in validate.rs could only
//          assert the ANSWER, never that it was reached for the intended reason.
//
//          (3) RULE 4 - MIXED DIRECTION UNDER AGGREGATION. If a rule constrains a
//          column the fact does NOT fix (the fact aggregates over it) and would
//          set a different value than the remaining members resolve to, the
//          attribute is SUPPRESSED and the reason names the rule. Never silently
//          pick one. Concretely: returns are good in the Refunds department and
//          bad everywhere else; a company-wide total of returns aggregates over
//          both, so it can carry NO favourability claim at all. Picking either
//          answer would tell half the company the opposite of the truth, and
//          picking "whichever rule sorted first" would do it unpredictably.
//
//          `ModelFacts` is a small local input struct rather than a dependency on
//          `bi_engine`: the caller populates it from whatever model type it holds.
//          That keeps the strategy layer testable with no engine in the process,
//          which is what lets these tests run under `cargo test` in seconds.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use super::overlap::specificity;
use super::types::{
    AggregationSpec, Attribute, AttributeSet, Cadence, Direction, Materiality, QualifiedColumn,
    Rule, Scope, ScopeValue, StrategyDoc, SuppressibleFactKind, TableKind, Target, Unit,
};

// ---------------------------------------------------------------------------
// The model side of the contract
// ---------------------------------------------------------------------------

/// What the model itself declares about one measure.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasureFacts {
    /// The table the measure aggregates over, used for reachability.
    pub fact_table: Option<String>,
    pub unit: Option<Unit>,
    pub kpi: Option<KpiFacts>,
}

/// How good a KPI band says the ratio is. Mirrors the engine's `KpiStatus`
/// without importing it, for the reason in this file's header: nothing here may
/// pull `bi_engine` into the test binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BandStatus {
    OffTrack,
    AtRisk,
    OnTrack,
}

impl BandStatus {
    /// Rank on the bad -> good axis. Comparing these across consecutive bands is
    /// the ONLY thing in a KPI that says which way is good.
    fn goodness(self) -> u8 {
        match self {
            BandStatus::OffTrack => 0,
            BandStatus::AtRisk => 1,
            BandStatus::OnTrack => 2,
        }
    }

    /// The wire spelling, for a validation message that has to quote a band.
    pub fn label(self) -> &'static str {
        match self {
            BandStatus::OffTrack => "offTrack",
            BandStatus::AtRisk => "atRisk",
            BandStatus::OnTrack => "onTrack",
        }
    }
}

/// One band of a KPI's status scale: a ratio at or above `threshold` carries
/// `status` until the next band's threshold.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KpiBand {
    pub threshold: f64,
    pub status: BandStatus,
}

impl KpiBand {
    pub fn new(threshold: f64, status: BandStatus) -> Self {
        Self { threshold, status }
    }
}

/// A model KPI: a goal and the status bands around it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KpiFacts {
    /// The KPI's own name, so provenance can say WHICH KPI decided something.
    ///
    /// "direction: higherIsBetter (KPI: Margin % KPI)" is an answer a reader can
    /// act on; "higherIsBetter (inferred)" sends them looking for the inference.
    #[serde(default)]
    pub name: String,
    pub target: Option<f64>,
    /// Threshold AND status, in the order the model declares them.
    ///
    /// THE STATUS IS THE SIGNAL, NOT THE THRESHOLD. The engine's builder refuses
    /// a KPI whose thresholds do not ascend (`Kpi::with_status_band`), so
    /// "do the thresholds ascend?" is true of every KPI that exists and answers
    /// nothing. Which way is good is carried entirely by whether the statuses run
    /// offTrack -> onTrack or onTrack -> offTrack as the ratio grows.
    pub bands: Vec<KpiBand>,
}

impl KpiFacts {
    /// Which way the bands say is good, or `None` when they do not say.
    ///
    /// A single band states no ordering; a flat sequence (every band onTrack)
    /// states no ordering; a sequence that goes up and then down again states two
    /// contradictory orderings. All three yield NO direction, because a guess
    /// here is exactly a confidently backwards "which is worse" sentence.
    pub fn direction(&self) -> Option<Direction> {
        if self.bands.len() < 2 {
            return None;
        }
        // Sorted by threshold rather than trusted in declaration order: the
        // engine validates the ascent, but a `ModelFacts` can also be built by
        // hand, and "as the ratio grows" must mean the ratio and not the order
        // somebody happened to type.
        let mut bands: Vec<&KpiBand> = self.bands.iter().collect();
        bands.sort_by(|a, b| a.threshold.partial_cmp(&b.threshold).unwrap_or(std::cmp::Ordering::Equal));

        let mut rises = false;
        let mut falls = false;
        for w in bands.windows(2) {
            let (a, b) = (w[0].status.goodness(), w[1].status.goodness());
            if b > a {
                rises = true;
            } else if b < a {
                falls = true;
            }
        }
        match (rises, falls) {
            (true, false) => Some(Direction::HigherIsBetter),
            (false, true) => Some(Direction::LowerIsBetter),
            _ => None,
        }
    }

    /// The bands as `0.9:atRisk`, for a finding that must quote them.
    pub fn band_summary(&self) -> String {
        self.bands
            .iter()
            .map(|b| format!("{}:{}", b.threshold, b.status.label()))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableFacts {
    pub kind: Option<TableKind>,
    pub columns: BTreeSet<String>,
    /// Declared members per column. An absent or empty entry means "the member
    /// list is not known here", which the resolver treats as "cannot prove full
    /// coverage" rather than as "no members".
    #[serde(default)]
    pub members: BTreeMap<String, Vec<String>>,
    /// The MODEL's own hierarchies on this table, coarse-to-fine, in the order
    /// the engine declares their levels.
    ///
    /// `TableStrategy::hierarchies` is a COPY of this that `infer` writes. The
    /// copy is the only one validate.rs used to be able to see, so a rule scoped
    /// on a real hierarchy level in a document nobody had run inference over was
    /// refused for having a role that "cannot scope" - a refusal of a document
    /// that was right.
    #[serde(default)]
    pub hierarchies: Vec<Vec<String>>,
}

/// Where a `ModelFacts`'s calendar came from.
///
/// THE DISTINCTION IS THE WHOLE POINT OF CARRYING IT. A declared date table is
/// the model author's own statement about what time means in this model; an
/// authored one is the same person saying it in the ANNOTATION layer, where the
/// engine's own time intelligence cannot hear it; an inferred one is `facts.rs`
/// reading column names and guessing. All three drive the same time axis, the
/// same trend facts and the same seasonality claims, so a reader who cannot
/// tell them apart is being handed a guess wearing a declaration's clothes —
/// which is the "honest and invisible" failure the planner's notes exist to
/// prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarSource {
    /// `mark_date_table`: somebody said so IN THE MODEL.
    Declared,
    /// The strategy document names this table `kind: "calendar"`: somebody said
    /// so IN THE ANNOTATION LAYER, and the model itself still marks nothing.
    ///
    /// A separate variant from `Declared` because the two have different
    /// consequences and a reader is owed the difference. The engine's time
    /// intelligence resolves against `model.date_table()` alone
    /// (`compute/time_intelligence.rs`), so an authored calendar gives the
    /// insights run a time axis while `TOTALYTD` in the same model still
    /// refuses. That is worth saying out loud, and it is not a guess, so it
    /// cannot be folded into `Inferred`.
    Authored,
    /// `infer_date_table` in facts.rs: nobody said so and the shape fit.
    Inferred,
}

/// Everything the resolver needs from the semantic model, and nothing more.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFacts {
    pub measures: BTreeMap<String, MeasureFacts>,
    pub tables: BTreeMap<String, TableFacts>,
    /// The calendar, from the highest rung that answered: the table the model
    /// MARKED, else the one the strategy document AUTHORED as `kind: calendar`,
    /// else the one `facts.rs` inferred when neither said anything.
    pub date_table: Option<String>,
    /// Which of those THREE rungs it came from. `None` exactly when `date_table`
    /// is `None`.
    ///
    /// Separate from `date_table` rather than folded into it because every
    /// existing reader wants only the NAME, and every one of them would have had
    /// to learn about provenance to keep asking the same question.
    #[serde(default)]
    pub calendar_source: Option<CalendarSource>,
    /// Relationship endpoints, as column pairs. Direction is irrelevant to
    /// reachability, so they are stored unordered.
    pub relationships: Vec<(QualifiedColumn, QualifiedColumn)>,
    /// Tables the model LOOKS UP: the to-side of at least one active
    /// many-to-one or one-to-one relationship.
    ///
    /// THIS IS THE ONE TOPOLOGICAL FACT `relationships` CANNOT CARRY. The pairs
    /// above are pushed for every active relationship whatever its cardinality,
    /// so a to-side read off them counts the ends of a many-to-many — and
    /// calling one of those a dimension is how a bridge table ends up offered as
    /// an analysis axis (`facts.rs` has refused it since the beginning, but only
    /// inside its own function). It is stored because it is what DISPROVES an
    /// authored `kind`: a table nothing looks up cannot be a dimension or a
    /// calendar, and `validate.rs` has no `DataModel` to work that out from.
    #[serde(default)]
    pub lookup_tables: BTreeSet<String>,
}

impl ModelFacts {
    pub fn has_table(&self, table: &str) -> bool {
        self.tables.contains_key(table)
    }

    pub fn has_column(&self, col: &QualifiedColumn) -> bool {
        self.tables
            .get(&col.table)
            .map(|t| t.columns.contains(&col.column))
            .unwrap_or(false)
    }

    /// Does a MODEL hierarchy on the column's table name it?
    ///
    /// The mirror of `StrategyDoc::in_a_hierarchy`. Validation asks both, because
    /// a level the model declares is a level whether or not the strategy document
    /// has caught up with it.
    pub fn in_a_hierarchy(&self, col: &QualifiedColumn) -> bool {
        self.tables
            .get(&col.table)
            .map(|t| t.hierarchies.iter().any(|h| h.iter().any(|c| c == &col.column)))
            .unwrap_or(false)
    }

    pub fn known_members(&self, col: &QualifiedColumn) -> Option<&Vec<String>> {
        self.tables
            .get(&col.table)
            .and_then(|t| t.members.get(&col.column))
            .filter(|m| !m.is_empty())
    }

    /// Tables ONE relationship away from `from`, `from` included.
    ///
    /// This is the reachability that matters for slicing, and it is deliberately
    /// narrower than `reachable_tables`. The query executor refuses relationship
    /// paths longer than a single hop, so an attribute on a snowflaked dimension
    /// is not something the planner can ask for — offering it would produce a
    /// breakdown the engine declines to compute. The strategy layer reports such
    /// an attribute as unreachable instead, which is the difference between a
    /// missing section a user can ask about and one that silently is not there.
    pub fn directly_related_tables(&self, from: &str) -> BTreeSet<String> {
        let mut out: BTreeSet<String> = BTreeSet::new();
        out.insert(from.to_string());
        for (a, b) in &self.relationships {
            if a.table == from {
                out.insert(b.table.clone());
            } else if b.table == from {
                out.insert(a.table.clone());
            }
        }
        out
    }

    /// Every table joinable to `from` along ANY number of hops, `from` included.
    ///
    /// A breadth-first walk over relationship endpoints, direction ignored. Use
    /// it to answer "is this table connected to the model at all"; use
    /// `directly_related_tables` to answer "can a fact be sliced by it", because
    /// only the second matches what the executor will do.
    pub fn reachable_tables(&self, from: &str) -> BTreeSet<String> {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut queue: VecDeque<String> = VecDeque::new();
        seen.insert(from.to_string());
        queue.push_back(from.to_string());
        while let Some(t) = queue.pop_front() {
            for (a, b) in &self.relationships {
                let next = if a.table == t {
                    Some(&b.table)
                } else if b.table == t {
                    Some(&a.table)
                } else {
                    None
                };
                if let Some(n) = next {
                    if seen.insert(n.clone()) {
                        queue.push_back(n.clone());
                    }
                }
            }
        }
        seen
    }
}

// ---------------------------------------------------------------------------
// The point being resolved
// ---------------------------------------------------------------------------

/// Where in the analysis space a fact sits.
///
/// The split is the whole of Rule 4: a column the fact FIXES admits exactly one
/// member and a rule either matches it or does not, while a column the fact
/// AGGREGATES OVER admits many and a rule may cover only some of them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopePoint {
    /// Columns pinned to one member.
    pub fixed: BTreeMap<QualifiedColumn, String>,
    /// Columns rolled up, with the members rolled up. An empty vector means "use
    /// the model's declared members"; if those are unknown too, the resolver
    /// cannot prove a rule covers everything and treats it as partial.
    pub aggregated: BTreeMap<QualifiedColumn, Vec<String>>,
}

impl ScopePoint {
    /// A point that fixes the given columns and aggregates over everything else.
    pub fn fixing<I, T, M>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (T, M)>,
        T: Into<QualifiedColumn>,
        M: Into<String>,
    {
        Self {
            fixed: pairs.into_iter().map(|(c, m)| (c.into(), m.into())).collect(),
            aggregated: BTreeMap::new(),
        }
    }

    pub fn aggregating_over(mut self, col: QualifiedColumn, members: Vec<String>) -> Self {
        self.aggregated.insert(col, members);
        self
    }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/// Where an attribute's value came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttrSource {
    /// The model states it outright.
    Base,
    /// Derived from something the model states (KPI band ordering, say).
    Inferred,
    /// A named model KPI supplied it.
    Kpi(String),
    /// The measure's own entry in the strategy document.
    Strategy,
    /// A scoped rule, by id.
    Rule(String),
}

/// A resolved attribute value and its provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Applied<T> {
    pub value: T,
    pub source: AttrSource,
}

impl<T> Applied<T> {
    pub fn new(value: T, source: AttrSource) -> Self {
        Self { value, source }
    }

    /// The rule id, when a rule is what decided this.
    pub fn rule_id(&self) -> Option<&str> {
        match &self.source {
            AttrSource::Rule(id) => Some(id.as_str()),
            _ => None,
        }
    }
}

/// One attribute withheld, and why. The rule is always named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Suppression {
    pub attribute: Attribute,
    pub rule: String,
    pub reason: String,
}

/// The answer: what the strategy says about this measure at this point.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedMeasure {
    pub measure: String,
    pub direction: Option<Applied<Direction>>,
    pub aggregation: Option<Applied<AggregationSpec>>,
    pub unit: Option<Applied<Unit>>,
    pub target: Option<Applied<Target>>,
    pub materiality: Option<Applied<Materiality>>,
    /// How often this measure is reported on.
    ///
    /// RESOLVED AND DISPLAYED, NEVER ACTED ON. Nothing on the run path reads it:
    /// `model.rs`, `model_commands.rs` and `report.rs` never mention cadence, so
    /// the planner does not bucket periods by it and no fact is withheld for
    /// being off-cadence. It is written here (layered like every other
    /// attribute) and surfaces in the Strategy tab's inheritance list, which is
    /// where its value is - a person can see what the machine believes and
    /// correct it. Inside the strategy layer the one Rust reader of a cadence is
    /// `infer`, which SEEDS the draft from `UsageIndex::cadence_for`; the
    /// Model Editor CLI prints the stored one (`cli/readers.ts`). Scoped that
    /// way and no wider: `cadence` is also a live field of the SCRIPTING
    /// scheduler (`scripting/scheduler.rs`), an unrelated concept that happens
    /// to share the word.
    pub cadence: Option<Applied<Cadence>>,
    pub priority: Option<Applied<u32>>,
    pub rank_weight: Option<Applied<f64>>,
    /// Fact kinds withheld here, as the union of every rule that reaches.
    pub suppressed_kinds: BTreeSet<SuppressibleFactKind>,
    pub analysis_dimensions: Vec<QualifiedColumn>,
    pub never_slice_by: Vec<QualifiedColumn>,
    /// PROSE, for the narrative layer only.
    pub context: Option<String>,
    /// Attributes deliberately withheld under Rule 4.
    pub suppressions: Vec<Suppression>,
}

impl ResolvedMeasure {
    pub fn suppression_of(&self, attribute: Attribute) -> Option<&Suppression> {
        self.suppressions.iter().find(|s| s.attribute == attribute)
    }
}

// ---------------------------------------------------------------------------
// Rule applicability
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Applicability {
    /// The rule claims nothing at this point.
    No,
    /// The rule claims SOME of the members this fact rolls up, over this column.
    Partial { over: QualifiedColumn },
    /// The rule claims the whole point.
    Full,
}

fn constraint_admits(constraint: &ScopeValue, member: &str) -> bool {
    match constraint {
        ScopeValue::Members(allowed) => allowed.iter().any(|m| m == member),
        // ISO-8601 string comparison, which is exact only because the bounds
        // are `IsoDate` and that type refuses anything else WHERE IT IS READ.
        // Not validate.rs, which this line used to name: the
        // `malformed-date-range` finding was deleted when the newtype took the
        // job over, and `validate_scope` says so itself. An absent `to` is
        // "onwards", so only the lower bound constrains.
        ScopeValue::DateRange { from, to } => {
            from.as_str() <= member && to.as_ref().is_none_or(|t| member <= t.as_str())
        }
    }
}

fn applicability(rule: &Rule, point: &ScopePoint, facts: &ModelFacts) -> Applicability {
    let mut partial_over: Option<QualifiedColumn> = None;
    for (col, constraint) in &rule.scope {
        if let Some(member) = point.fixed.get(col) {
            if !constraint_admits(constraint, member) {
                return Applicability::No;
            }
            continue;
        }
        // Not fixed => the fact aggregates over it, whether the caller listed it
        // or not. A fact that never mentions Region sums every region.
        let universe = point
            .aggregated
            .get(col)
            .filter(|m| !m.is_empty())
            .or_else(|| facts.known_members(col));
        match (constraint, universe) {
            (ScopeValue::Members(allowed), Some(universe)) => {
                let covered = universe.iter().filter(|m| allowed.contains(m)).count();
                if covered == 0 {
                    return Applicability::No;
                }
                if covered < universe.len() && partial_over.is_none() {
                    partial_over = Some(col.clone());
                }
            }
            // Either the member universe is unknown, or the constraint is a date
            // range over a rolled-up axis. Full coverage cannot be PROVED, and
            // assuming it is how a rule quietly takes over an aggregate it only
            // partly describes - so it counts as partial and Rule 4 applies.
            _ => {
                if partial_over.is_none() {
                    partial_over = Some(col.clone());
                }
            }
        }
    }
    match partial_over {
        Some(over) => Applicability::Partial { over },
        None => Applicability::Full,
    }
}

struct RuleView<'a> {
    rule: &'a Rule,
    spec: usize,
    partial_over: Option<QualifiedColumn>,
}

/// Layer one attribute: rules over the inherited value, most specific wins,
/// with Rule 4 applied to any rule that only partly covers the aggregate.
fn layer<T, F>(
    attribute: Attribute,
    inherited: Option<Applied<T>>,
    views: &[RuleView<'_>],
    get: F,
    suppressions: &mut Vec<Suppression>,
) -> Option<Applied<T>>
where
    T: Clone + PartialEq,
    F: Fn(&AttributeSet) -> Option<T>,
{
    let mut best: Option<&RuleView<'_>> = None;
    for v in views.iter().filter(|v| v.partial_over.is_none()) {
        if get(&v.rule.set).is_none() {
            continue;
        }
        best = match best {
            None => Some(v),
            // Ties at equal specificity are refused by overlap.rs before a
            // document is ever resolved. Breaking the tie by rule id anyway keeps
            // this function TOTAL and deterministic - a resolver that panicked or
            // picked by iteration order on an unvalidated document would be a
            // second, worse failure mode.
            Some(b) if v.spec > b.spec || (v.spec == b.spec && v.rule.id < b.rule.id) => Some(v),
            Some(b) => Some(b),
        };
    }

    let resolved = match best {
        Some(v) => Some(Applied::new(
            get(&v.rule.set).expect("filtered above"),
            AttrSource::Rule(v.rule.id.clone()),
        )),
        None => inherited,
    };

    // RULE 4 APPLIES TO DIRECTION AND ONLY TO DIRECTION.
    //
    // Withholding a direction makes the engine say LESS: the number is still
    // reported, with no claim about whether it is good news. That is the honest
    // answer when a total sums parts that mean opposite things.
    //
    // Withholding any OTHER attribute makes the engine say MORE, which is the
    // opposite of safe. A materiality withheld is a threshold of zero, so a
    // rule raising the floor inside one product category would remove the floor
    // from the company total and turn every rounding wiggle into a fact. A
    // target withheld is no variance line at all. In both cases the correct
    // value for the aggregate is the one the OTHER members already resolve to,
    // and a rule that constrains a column this fact rolls up simply does not
    // speak about this fact — so it is ignored rather than allowed to erase the
    // general answer.
    if attribute != Attribute::Direction {
        return resolved;
    }

    for v in views.iter() {
        let Some(over) = v.partial_over.as_ref() else {
            continue;
        };
        let Some(value) = get(&v.rule.set) else {
            continue;
        };
        if resolved.as_ref().map(|a| &a.value) == Some(&value) {
            // It agrees with what the other members resolve to, so aggregating is
            // not mixing anything.
            continue;
        }
        suppressions.push(Suppression {
            attribute,
            rule: v.rule.id.clone(),
            reason: format!(
                "rule '{}' sets '{}' for only some of the {} members this fact aggregates over, \
                 and it disagrees with what the rest resolve to; a single fact cannot carry two \
                 answers, so '{}' is withheld here",
                v.rule.id, attribute, over, attribute
            ),
        });
        return None;
    }

    resolved
}

/// Resolve one measure at one point.
pub fn resolve(
    facts: &ModelFacts,
    doc: &StrategyDoc,
    measure: &str,
    point: &ScopePoint,
) -> ResolvedMeasure {
    let mf = facts.measures.get(measure);
    let entry = doc.measures.get(measure);

    // --- Layer 1: base, everything the model itself states or implies. --------
    // A KPI's band ordering is a statement about which way is good, so the
    // provenance names the KPI rather than saying "inferred". The reader's next
    // question after "why is a rise bad here?" is "says who?", and this is the
    // only layer that can answer it with an object they can go and look at.
    let kpi = mf.and_then(|m| m.kpi.as_ref());
    let kpi_source = || AttrSource::Kpi(kpi.map(|k| k.name.clone()).unwrap_or_default());
    let mut direction = kpi
        .and_then(|k| k.direction())
        .map(|d| Applied::new(d, kpi_source()));
    let mut target = kpi
        .and_then(|k| k.target)
        .map(|v| Applied::new(Target::Literal { value: v }, kpi_source()));
    let mut unit = mf
        .and_then(|m| m.unit)
        .map(|u| Applied::new(u, AttrSource::Base));
    // Additive is the model's own default for a measure that says nothing.
    let mut aggregation = Some(Applied::new(
        AggregationSpec {
            default: super::types::Additivity::Additive,
            by_dimension: BTreeMap::new(),
        },
        AttrSource::Base,
    ));
    let mut materiality: Option<Applied<Materiality>> = None;
    let mut cadence: Option<Applied<Cadence>> = None;
    let mut priority: Option<Applied<u32>> = None;

    // --- Layer 2: the measure's own strategy entry. ---------------------------
    if let Some(e) = entry {
        if let Some(d) = e.direction {
            direction = Some(Applied::new(d, AttrSource::Strategy));
        }
        if let Some(t) = e.target.clone() {
            // `{"type": "kpi"}` means "whatever the model's KPI says", so it is
            // RESOLVED here rather than passed through. A consumer that received
            // the marker would have to reach back into the model to get a
            // number, and every consumer would have to remember to.
            target = match (&t, kpi.and_then(|k| k.target)) {
                (Target::Kpi, Some(v)) => Some(Applied::new(Target::Literal { value: v }, kpi_source())),
                // A KPI whose target is another MEASURE has no number until a
                // query runs. The marker survives, so the planner knows to ask.
                _ => Some(Applied::new(t, AttrSource::Strategy)),
            };
        }
        if let Some(u) = e.unit {
            unit = Some(Applied::new(u, AttrSource::Strategy));
        }
        if let Some(a) = e.aggregation.clone() {
            aggregation = Some(Applied::new(a, AttrSource::Strategy));
        }
        if let Some(m) = e.materiality.clone() {
            materiality = Some(Applied::new(m, AttrSource::Strategy));
        }
        if let Some(c) = e.cadence {
            cadence = Some(Applied::new(c, AttrSource::Strategy));
        }
        if let Some(p) = e.priority {
            priority = Some(Applied::new(p, AttrSource::Strategy));
        }
    }
    if priority.is_none() {
        if let Some(i) = doc.model.priority.iter().position(|m| m == measure) {
            priority = Some(Applied::new(i as u32, AttrSource::Strategy));
        }
    }

    // --- Layer 3: rules, attribute by attribute. ------------------------------
    let views: Vec<RuleView<'_>> = doc
        .rules
        .iter()
        .filter(|r| r.measure == measure)
        .filter_map(|r| match applicability(r, point, facts) {
            Applicability::No => None,
            Applicability::Full => Some(RuleView {
                rule: r,
                spec: specificity(&r.scope),
                partial_over: None,
            }),
            Applicability::Partial { over } => Some(RuleView {
                rule: r,
                spec: specificity(&r.scope),
                partial_over: Some(over),
            }),
        })
        .collect();

    let mut suppressions = Vec::new();
    let direction = layer(
        Attribute::Direction,
        direction,
        &views,
        |s| s.direction,
        &mut suppressions,
    );
    let target = layer(
        Attribute::Target,
        target,
        &views,
        |s| s.target.clone(),
        &mut suppressions,
    );
    let materiality = layer(
        Attribute::Materiality,
        materiality,
        &views,
        |s| s.materiality.clone(),
        &mut suppressions,
    );
    let cadence = layer(
        Attribute::Cadence,
        cadence,
        &views,
        |s| s.cadence,
        &mut suppressions,
    );
    let aggregation = layer(
        Attribute::Aggregation,
        aggregation,
        &views,
        |s| s.aggregation.clone(),
        &mut suppressions,
    );
    let rank_weight = layer(
        Attribute::RankWeight,
        None,
        &views,
        |s| s.rank_weight,
        &mut suppressions,
    );

    // Suppression is the one attribute that unions rather than picks, so a rule
    // covering only part of the aggregate still applies: withholding a fact kind
    // for a region it partly describes is the cautious direction, and unlike a
    // direction flip it cannot state anything false.
    let mut suppressed_kinds: BTreeSet<SuppressibleFactKind> = BTreeSet::new();
    for v in &views {
        for kind in &v.rule.set.suppress {
            suppressed_kinds.insert(*kind);
        }
    }

    ResolvedMeasure {
        measure: measure.to_string(),
        direction,
        aggregation,
        unit,
        target,
        materiality,
        cadence,
        priority,
        rank_weight,
        suppressed_kinds,
        analysis_dimensions: entry.map(|e| e.analysis_dimensions.clone()).unwrap_or_default(),
        never_slice_by: entry.map(|e| e.never_slice_by.clone()).unwrap_or_default(),
        context: entry.and_then(|e| e.context.clone()),
        suppressions,
    }
}

/// Convenience for callers building a point out of a scope: a column pinned to
/// exactly one member is FIXED, anything wider is AGGREGATED.
pub fn point_from_scope(scope: &Scope) -> ScopePoint {
    let mut point = ScopePoint::default();
    for (col, v) in scope {
        match v {
            ScopeValue::Members(m) if m.len() == 1 => {
                point.fixed.insert(col.clone(), m[0].clone());
            }
            ScopeValue::Members(m) => {
                point.aggregated.insert(col.clone(), m.clone());
            }
            ScopeValue::DateRange { .. } => {
                point.aggregated.insert(col.clone(), Vec::new());
            }
        }
    }
    point
}

#[cfg(test)]
mod tests {
    use super::*;
    // Everything else (StrategyDoc, Rule, Scope, Direction, ...) arrives through
    // `use super::*`; re-importing it here would be a duplicate name.
    use crate::insights::strategy::types::{
        Additivity, ColumnStrategy, MeasureStrategy, Role, TableStrategy,
    };

    fn col(t: &str, c: &str) -> QualifiedColumn {
        QualifiedColumn::new(t, c)
    }

    /// One fact table, one dimension with two departments, joined.
    fn facts() -> ModelFacts {
        ModelFacts {
            measures: BTreeMap::from([(
                "Returns".to_string(),
                MeasureFacts {
                    fact_table: Some("Sales".into()),
                    unit: Some(Unit::Currency),
                    kpi: None,
                },
            )]),
            tables: BTreeMap::from([
                (
                    "Sales".to_string(),
                    TableFacts {
                        kind: Some(TableKind::Fact),
                        columns: BTreeSet::from(["DeptKey".to_string(), "Amount".to_string()]),
                        members: BTreeMap::new(),
                        hierarchies: Vec::new(),
                    },
                ),
                (
                    "Dim".to_string(),
                    TableFacts {
                        kind: Some(TableKind::Dimension),
                        columns: BTreeSet::from(["Dept".to_string(), "DeptKey".to_string()]),
                        members: BTreeMap::from([(
                            "Dept".to_string(),
                            vec!["Refunds".to_string(), "Retail".to_string()],
                        )]),
                        hierarchies: Vec::new(),
                    },
                ),
            ]),
            date_table: None,
            calendar_source: None,
            relationships: vec![(col("Sales", "DeptKey"), col("Dim", "DeptKey"))],
            lookup_tables: BTreeSet::from(["Dim".to_string()]),
        }
    }

    fn doc_with_refunds_rule() -> StrategyDoc {
        let mut doc = StrategyDoc::default();
        doc.tables.insert(
            "Dim".into(),
            TableStrategy {
                columns: BTreeMap::from([(
                    "Dept".to_string(),
                    ColumnStrategy {
                        role: Role::Analysis,
                        priority: None,
                        x: Default::default(),
                    },
                )]),
                ..Default::default()
            },
        );
        doc.measures.insert(
            "Returns".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                materiality: Some(Materiality::Absolute { value: 1000.0 }),
                reviewed: true,
                ..Default::default()
            },
        );
        // In the Refunds department, returns going UP is the department doing its
        // job. Everywhere else it is money lost.
        doc.rules.push(Rule {
            id: "refunds-dept".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Refunds".into()]),
            )]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        doc
    }

    #[test]
    fn mixed_direction_under_aggregation_suppresses_and_names_the_rule() {
        let facts = facts();
        let doc = doc_with_refunds_rule();

        // A company-wide total: Dept is not fixed, so the fact rolls up both
        // Refunds (higher is better) and Retail (lower is better).
        let point = ScopePoint::default();
        let r = resolve(&facts, &doc, "Returns", &point);

        assert!(
            r.direction.is_none(),
            "an aggregate spanning two directions must carry no favourability claim, got {:?}",
            r.direction
        );
        let s = r
            .suppression_of(Attribute::Direction)
            .expect("the suppression must be recorded, not silent");
        assert_eq!(s.rule, "refunds-dept", "the reason must name the rule");
        assert!(
            s.reason.contains("refunds-dept") && s.reason.contains("Dim[Dept]"),
            "the reason must name the rule and the column: {}",
            s.reason
        );

        // The attributes the rule did NOT touch survive untouched - this is what
        // per-attribute layering buys.
        assert_eq!(
            r.materiality,
            Some(Applied::new(
                Materiality::Absolute { value: 1000.0 },
                AttrSource::Strategy
            )),
            "suppressing direction must not take materiality with it"
        );
        assert!(matches!(
            r.aggregation.as_ref().map(|a| &a.source),
            Some(AttrSource::Base)
        ));
    }

    #[test]
    fn the_same_rule_applies_cleanly_once_the_fact_fixes_the_column() {
        // Positive control for the suppression above: at Dept=Refunds the rule is
        // not mixing anything and must WIN, with its id recorded.
        let facts = facts();
        let doc = doc_with_refunds_rule();
        let point = ScopePoint::fixing([(col("Dim", "Dept"), "Refunds")]);
        let r = resolve(&facts, &doc, "Returns", &point);
        assert_eq!(
            r.direction,
            Some(Applied::new(
                Direction::HigherIsBetter,
                AttrSource::Rule("refunds-dept".into())
            ))
        );
        assert!(r.suppressions.is_empty());

        // ...and at Dept=Retail the rule does not reach at all.
        let retail = ScopePoint::fixing([(col("Dim", "Dept"), "Retail")]);
        let r = resolve(&facts, &doc, "Returns", &retail);
        assert_eq!(
            r.direction,
            Some(Applied::new(Direction::LowerIsBetter, AttrSource::Strategy))
        );
        assert!(r.suppressions.is_empty());
    }

    #[test]
    fn a_partial_rule_that_agrees_with_the_rest_does_not_suppress() {
        // Rule 4 fires on DISAGREEMENT, not on partial coverage. A rule that says
        // the same thing the inherited value says mixes nothing.
        let facts = facts();
        let mut doc = doc_with_refunds_rule();
        doc.rules[0].set.direction = Some(Direction::LowerIsBetter);
        let r = resolve(&facts, &doc, "Returns", &ScopePoint::default());
        assert!(r.suppressions.is_empty());
        assert_eq!(
            r.direction.as_ref().map(|a| a.value),
            Some(Direction::LowerIsBetter)
        );
    }

    #[test]
    fn a_rule_covering_every_aggregated_member_applies_in_full() {
        let facts = facts();
        let mut doc = doc_with_refunds_rule();
        doc.rules[0].scope = Scope::from([(
            col("Dim", "Dept"),
            ScopeValue::Members(vec!["Refunds".into(), "Retail".into()]),
        )]);
        let r = resolve(&facts, &doc, "Returns", &ScopePoint::default());
        assert_eq!(
            r.direction,
            Some(Applied::new(
                Direction::HigherIsBetter,
                AttrSource::Rule("refunds-dept".into())
            )),
            "covering the whole rolled-up universe is not partial"
        );
    }

    #[test]
    fn a_rule_setting_only_direction_leaves_every_other_attribute_inherited() {
        let facts = facts();
        let mut doc = doc_with_refunds_rule();
        doc.measures.get_mut("Returns").unwrap().cadence = Some(Cadence::Monthly);
        doc.measures.get_mut("Returns").unwrap().aggregation = Some(AggregationSpec {
            default: Additivity::LastValue,
            by_dimension: BTreeMap::new(),
        });
        let point = ScopePoint::fixing([(col("Dim", "Dept"), "Refunds")]);
        let r = resolve(&facts, &doc, "Returns", &point);

        assert_eq!(r.direction.as_ref().unwrap().source, AttrSource::Rule("refunds-dept".into()));
        assert_eq!(r.cadence, Some(Applied::new(Cadence::Monthly, AttrSource::Strategy)));
        assert_eq!(
            r.aggregation.as_ref().unwrap().value.default,
            Additivity::LastValue
        );
        // The measure entry declares no unit, so the model's own unit survives
        // all three layers untouched.
        assert_eq!(r.unit, Some(Applied::new(Unit::Currency, AttrSource::Base)));
    }

    #[test]
    fn the_most_specific_applicable_rule_wins_and_records_its_id() {
        let facts = facts();
        let mut doc = doc_with_refunds_rule();
        doc.rules.push(Rule {
            id: "refunds-nordics".into(),
            measure: "Returns".into(),
            scope: Scope::from([
                (col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()])),
                (col("Geo", "Region"), ScopeValue::Members(vec!["Nordics".into()])),
            ]),
            set: AttributeSet {
                direction: Some(Direction::Neutral),
                ..Default::default()
            },
            note: None,
        });
        let point = ScopePoint::fixing([
            (col("Dim", "Dept"), "Refunds"),
            (col("Geo", "Region"), "Nordics"),
        ]);
        let r = resolve(&facts, &doc, "Returns", &point);
        assert_eq!(
            r.direction,
            Some(Applied::new(
                Direction::Neutral,
                AttrSource::Rule("refunds-nordics".into())
            ))
        );
    }

    #[test]
    fn a_kpi_with_ascending_bands_infers_higher_is_better_and_says_it_inferred_it() {
        let mut facts = facts();
        facts.measures.insert(
            "Margin".into(),
            MeasureFacts {
                fact_table: Some("Sales".into()),
                unit: Some(Unit::Percent),
                kpi: Some(KpiFacts {
                    name: "Margin KPI".into(),
                    target: Some(0.4),
                    bands: vec![
                        KpiBand::new(0.1, BandStatus::OffTrack),
                        KpiBand::new(0.25, BandStatus::AtRisk),
                        KpiBand::new(0.4, BandStatus::OnTrack),
                    ],
                }),
            },
        );
        let doc = StrategyDoc::default();
        let r = resolve(&facts, &doc, "Margin", &ScopePoint::default());
        // The provenance names the KPI, not the measure and not a vague
        // "inferred": the reader's next question after "why is a rise good?" is
        // "says who?", and a KPI is an object they can go and open.
        assert_eq!(
            r.direction,
            Some(Applied::new(
                Direction::HigherIsBetter,
                AttrSource::Kpi("Margin KPI".into())
            ))
        );
        assert_eq!(
            r.target,
            Some(Applied::new(
                Target::Literal { value: 0.4 },
                AttrSource::Kpi("Margin KPI".into())
            ))
        );
    }

    #[test]
    fn the_measure_entry_overrides_the_inferred_base_and_says_so() {
        let mut facts = facts();
        facts.measures.get_mut("Returns").unwrap().kpi = Some(KpiFacts {
            name: "Returns KPI".into(),
            target: None,
            bands: vec![
                KpiBand::new(0.1, BandStatus::OffTrack),
                KpiBand::new(0.2, BandStatus::OnTrack),
            ],
        });
        let doc = doc_with_refunds_rule();
        let r = resolve(&facts, &doc, "Returns", &ScopePoint::fixing([(col("Dim", "Dept"), "Retail")]));
        assert_eq!(
            r.direction,
            Some(Applied::new(Direction::LowerIsBetter, AttrSource::Strategy)),
            "the strategy entry sits above the inferred base"
        );
    }

    #[test]
    fn suppressed_fact_kinds_are_the_union_of_every_reaching_rule() {
        let facts = facts();
        let mut doc = doc_with_refunds_rule();
        // The rule that only PARTLY covers the aggregate still contributes:
        // suppression unions rather than picks, so Rule 4 does not apply to it.
        doc.rules[0].set.suppress = vec![SuppressibleFactKind::Contribution];
        doc.rules.push(Rule {
            id: "no-trend".into(),
            measure: "Returns".into(),
            scope: Scope::new(),
            set: AttributeSet {
                suppress: vec![SuppressibleFactKind::Trend],
                ..Default::default()
            },
            note: None,
        });
        let r = resolve(&facts, &doc, "Returns", &ScopePoint::default());
        assert_eq!(
            r.suppressed_kinds,
            BTreeSet::from([SuppressibleFactKind::Contribution, SuppressibleFactKind::Trend])
        );
    }

    #[test]
    fn reachability_walks_relationships_in_both_directions() {
        let facts = facts();
        assert_eq!(
            facts.reachable_tables("Sales"),
            BTreeSet::from(["Sales".to_string(), "Dim".to_string()])
        );
        assert_eq!(
            facts.reachable_tables("Dim"),
            BTreeSet::from(["Sales".to_string(), "Dim".to_string()])
        );
        assert_eq!(
            facts.reachable_tables("Orphan"),
            BTreeSet::from(["Orphan".to_string()])
        );
    }

    fn kpi_with(bands: Vec<KpiBand>) -> KpiFacts {
        KpiFacts {
            name: "K".into(),
            target: Some(1.0),
            bands,
        }
    }

    #[test]
    fn a_kpi_whose_statuses_worsen_as_the_ratio_grows_says_lower_is_better() {
        // A churn KPI: the closer the ratio gets to the ceiling, the worse it is.
        // The THRESHOLDS still ascend - the engine's builder refuses any KPI whose
        // thresholds do not - so reading the thresholds could only ever answer
        // "higher is better", which is how every churn KPI used to.
        let churn = kpi_with(vec![
            KpiBand::new(0.5, BandStatus::OnTrack),
            KpiBand::new(0.8, BandStatus::AtRisk),
            KpiBand::new(1.0, BandStatus::OffTrack),
        ]);
        assert_eq!(churn.direction(), Some(Direction::LowerIsBetter));

        let revenue = kpi_with(vec![
            KpiBand::new(0.5, BandStatus::OffTrack),
            KpiBand::new(0.9, BandStatus::AtRisk),
            KpiBand::new(1.0, BandStatus::OnTrack),
        ]);
        assert_eq!(revenue.direction(), Some(Direction::HigherIsBetter));
    }

    #[test]
    fn a_kpi_that_states_no_ordering_yields_no_direction_rather_than_a_guess() {
        // One band names a status but no ORDERING - there is nothing to compare
        // it against.
        assert_eq!(
            kpi_with(vec![KpiBand::new(0.9, BandStatus::OnTrack)]).direction(),
            None
        );
        // Every band the same: the KPI colours the number and says nothing about
        // which way is good.
        assert_eq!(
            kpi_with(vec![
                KpiBand::new(0.5, BandStatus::OnTrack),
                KpiBand::new(0.9, BandStatus::OnTrack),
            ])
            .direction(),
            None
        );
        // Good in the middle, bad at both ends: a band-shaped goal, which is a
        // `targetBand` a person must declare - not something to collapse into one
        // of the two monotone answers.
        assert_eq!(
            kpi_with(vec![
                KpiBand::new(0.5, BandStatus::OffTrack),
                KpiBand::new(0.9, BandStatus::OnTrack),
                KpiBand::new(1.2, BandStatus::OffTrack),
            ])
            .direction(),
            None
        );
    }

    #[test]
    fn the_band_order_that_decides_direction_is_the_ratio_and_not_the_typing_order() {
        // Same three bands, declared worst-threshold-last. "As the ratio grows"
        // must mean the ratio.
        let scrambled = kpi_with(vec![
            KpiBand::new(1.0, BandStatus::OffTrack),
            KpiBand::new(0.5, BandStatus::OnTrack),
            KpiBand::new(0.8, BandStatus::AtRisk),
        ]);
        assert_eq!(scrambled.direction(), Some(Direction::LowerIsBetter));
    }

    #[test]
    fn a_churn_kpi_resolves_to_lower_is_better_and_names_the_kpi() {
        // The end-to-end of the above: before status pairs reached KpiFacts this
        // resolved to higherIsBetter, so a rise in churn read as good news.
        let mut facts = facts();
        facts.measures.insert(
            "Churn".into(),
            MeasureFacts {
                fact_table: Some("Sales".into()),
                unit: Some(Unit::Percent),
                kpi: Some(KpiFacts {
                    name: "Churn KPI".into(),
                    target: Some(0.05),
                    bands: vec![
                        KpiBand::new(0.5, BandStatus::OnTrack),
                        KpiBand::new(1.0, BandStatus::OffTrack),
                    ],
                }),
            },
        );
        let r = resolve(&facts, &StrategyDoc::default(), "Churn", &ScopePoint::default());
        assert_eq!(
            r.direction,
            Some(Applied::new(
                Direction::LowerIsBetter,
                AttrSource::Kpi("Churn KPI".into())
            ))
        );
    }

    #[test]
    fn a_model_hierarchy_is_visible_through_the_facts() {
        let mut facts = facts();
        facts.tables.get_mut("Dim").unwrap().hierarchies = vec![vec!["Dept".into()]];
        assert!(facts.in_a_hierarchy(&col("Dim", "Dept")));
        assert!(!facts.in_a_hierarchy(&col("Dim", "DeptKey")));
        assert!(!facts.in_a_hierarchy(&col("Nope", "Dept")));
    }

    #[test]
    fn a_scope_pinning_one_member_becomes_a_fixed_point_and_a_wider_one_aggregates() {
        let scope = Scope::from([
            (col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()])),
            (
                col("Geo", "Region"),
                ScopeValue::Members(vec!["Nordics".into(), "DACH".into()]),
            ),
        ]);
        let point = point_from_scope(&scope);
        assert_eq!(point.fixed.get(&col("Dim", "Dept")).map(String::as_str), Some("Refunds"));
        assert_eq!(
            point.aggregated.get(&col("Geo", "Region")).map(Vec::len),
            Some(2)
        );
    }
}
