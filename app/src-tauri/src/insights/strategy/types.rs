//! FILENAME: app/src-tauri/src/insights/strategy/types.rs
// PURPOSE: The strategy document itself - the on-disk shape a consultant authors
//          and the vocabulary every other file in this subtree resolves against.
// CONTEXT: Two properties of these types are load-bearing and must survive any
//          later edit.
//
//          (1) `#[serde(deny_unknown_fields)]` is on EVERY container. A strategy
//          file is hand-written; without it, `higherIsBeter` or `analysisDimension`
//          parses cleanly and the engine silently generates the wrong facts
//          forever. A typo must be an error, not a shrug. This is the same
//          reasoning that put `deny_unknown_fields` on the .calp manifest types.
//
//          (2) `AttributeSet` - the ONLY thing a `Rule` can carry - has no field
//          that can assert a value about the data. `direction`, `materiality`,
//          `cadence` and `aggregation` say how to INTERPRET a number the model
//          computed; `suppress` removes fact kinds; `rankWeight` reorders. There
//          is deliberately no `value`, no `note` that reaches ranking, and no way
//          to state what a measure "is" at a point. `target` is the boundary case
//          and it stays because a target is a GOAL supplied by the business, not
//          an observation - the engine still computes the actual from the model
//          and compares. If a future field could let a rule put an unverified
//          number in front of a reader, it does not belong on `AttributeSet`.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The schema version a freshly written document carries.
pub const STRATEGY_DOC_VERSION: u32 = 1;

/// Every fact kind a `Rule`'s `suppress` list may name.
///
/// THE ONLY WAY A SUPPRESSION CAN FAIL IS BY SPELLING. `insights::model` filters
/// facts with `resolved.suppressed_kinds.contains(&kind.kind_key())`, so a key
/// nobody emits removes nothing and the author's instruction is silently
/// ignored - the fact they asked to withhold appears in the report.
///
/// The list lives here, in the vocabulary file, because it is part of the
/// document's contract with the person writing it; it is kept honest by
/// `every_fact_kind_a_run_can_emit_is_spelled_in_the_suppressible_list` in
/// `insights::model`, which builds one of each fact kind and diffs the two
/// directions. Add a `ModelFactKind` without adding it here and that test reds.
pub const SUPPRESSIBLE_FACT_KINDS: &[&str] = &[
    "change",
    "changePoint",
    "contribution",
    "definitionalDriver",
    "memberMove",
    "seasonality",
    "trend",
    "variance",
];

/// The serialized ceiling for one strategy document, in bytes.
///
/// 256 KB is not a taste judgement: it is the BI engine's per-key extension-data
/// cap, and a strategy document is stored as one such key. A document over the
/// cap is refused by the validator rather than truncated at write time, because
/// a truncated document parses as a DIFFERENT, smaller strategy and would apply
/// silently.
pub const MAX_STRATEGY_DOC_BYTES: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// QualifiedColumn
// ---------------------------------------------------------------------------

/// A column named the way a model author writes it: `Table[Column]`.
///
/// It is a map KEY in `Scope`, so it serializes as that one string rather than as
/// a nested object - a JSON object cannot have a structured key, and a
/// `[{table, column, value}]` array would let the same column appear twice with
/// two different constraints, which is exactly the ambiguity overlap.rs exists to
/// remove.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct QualifiedColumn {
    pub table: String,
    pub column: String,
}

impl QualifiedColumn {
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
        }
    }
}

impl fmt::Display for QualifiedColumn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}[{}]", self.table, self.column)
    }
}

/// Why a `Table[Column]` string could not be read. Carries the offending text so
/// a validation finding can quote it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifiedColumnParseError {
    pub input: String,
    pub reason: &'static str,
}

impl fmt::Display for QualifiedColumnParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "'{}' is not a Table[Column] reference: {}", self.input, self.reason)
    }
}

impl FromStr for QualifiedColumn {
    type Err = QualifiedColumnParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let fail = |reason: &'static str| QualifiedColumnParseError {
            input: s.to_string(),
            reason,
        };
        let open = s.find('[').ok_or_else(|| fail("no '[' in it"))?;
        if !s.ends_with(']') {
            return Err(fail("it does not end with ']'"));
        }
        let table = s[..open].trim();
        // The closing bracket is the LAST character, so the column is everything
        // between. A column name containing ']' is unrepresentable and is
        // rejected here rather than silently truncated.
        let column = &s[open + 1..s.len() - 1];
        if table.is_empty() {
            return Err(fail("the table name is empty"));
        }
        if column.is_empty() {
            return Err(fail("the column name is empty"));
        }
        if column.contains('[') || column.contains(']') {
            return Err(fail("the column name contains a bracket"));
        }
        Ok(QualifiedColumn::new(table, column))
    }
}

impl Serialize for QualifiedColumn {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for QualifiedColumn {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        QualifiedColumn::from_str(&raw).map_err(D::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/// Which way is good. The single most consequential field in the document: it is
/// what turns "-4%" into "worse".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    HigherIsBetter,
    LowerIsBetter,
    /// Good means inside a band; both ends are bad. Needs a `Target::Band`.
    TargetBand,
    /// Movement carries no favourability at all (headcount, a mix share).
    Neutral,
}

/// How a measure may be rolled up along a dimension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Additivity {
    Additive,
    /// Summable along nothing; must be re-evaluated at each grain.
    NonAdditive,
    LastValue,
    FirstValue,
    Average,
    Max,
    Min,
}

/// Per-dimension additivity. A stock balance is `Additive` over Product and
/// `LastValue` over Date, and getting that wrong produces a fact that is simply
/// false rather than merely uninteresting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AggregationSpec {
    pub default: Additivity,
    #[serde(default)]
    pub by_dimension: BTreeMap<String, Additivity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unit {
    Currency,
    Percent,
    Ratio,
    Count,
    Duration,
    Other,
}

/// A bound of a `Target::Band` is INCLUSIVE unless the document says otherwise.
///
/// A separate function rather than a literal in the attribute because
/// `#[serde(default)]` on a `bool` means `false`, and "the bound nobody
/// mentioned excludes its own endpoint" is the opposite of what a person writing
/// `low: 90000` means.
fn bound_is_inclusive() -> bool {
    true
}

/// Skip predicate for a bound that is inclusive, i.e. the default. A band whose
/// bounds are both ordinary still serializes as `{low, high}`, which is the form
/// the checked-in corpus and every hand-written document use.
fn is_inclusive(inclusive: &bool) -> bool {
    *inclusive
}

/// What "on target" means. A goal supplied by the business - never an observation.
///
/// INTERNALLY tagged, so a person writes `{"type": "literal", "value": 0.38}`
/// rather than serde's default `{"literal": {"value": 0.38}}`. This document is
/// hand-authored and hand-reviewed; the wire shape is a readability decision,
/// not an implementation detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    Literal { value: f64 },
    /// Another measure in the same model carries the target.
    Measure {
        // `ref` is a Rust keyword; the raw identifier keeps the WIRE name `ref`
        // without a per-field serde rename, which house rules forbid.
        r#ref: String,
    },
    /// Good means landing between `low` and `high`; both ends are bad.
    ///
    /// The inclusivity of each end is part of the band and not a separate
    /// parallel field, because a band whose ends are described somewhere else is
    /// a band that can be half-copied. `rename_all` sits on the VARIANT so the
    /// wire names are `lowInclusive` / `highInclusive` without a per-field
    /// rename, which house rules forbid.
    #[serde(rename_all = "camelCase")]
    Band {
        low: f64,
        high: f64,
        #[serde(default = "bound_is_inclusive", skip_serializing_if = "is_inclusive")]
        low_inclusive: bool,
        #[serde(default = "bound_is_inclusive", skip_serializing_if = "is_inclusive")]
        high_inclusive: bool,
    },
    /// Inherit whatever the model's own KPI declares for this measure.
    Kpi,
}

/// A band's bounds, flattened out of `Target::Band` so the two things that
/// actually ask about a band - "is this value inside it" and "can anything be
/// inside it" - are answered in ONE place.
///
/// Both questions read the inclusivity flags, which is what keeps them from
/// being decoration: `judge` in validate.rs decides a test's verdict with
/// `contains`, `favourability_at` in model.rs decides a shipped fact's
/// favourability with the same call, and `is_empty` is what refuses a band no
/// value can ever satisfy.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BandBounds {
    pub low: f64,
    pub high: f64,
    pub low_inclusive: bool,
    pub high_inclusive: bool,
}

impl BandBounds {
    /// Is this value inside the band?
    pub fn contains(&self, value: f64) -> bool {
        let above = if self.low_inclusive {
            value >= self.low
        } else {
            value > self.low
        };
        let below = if self.high_inclusive {
            value <= self.high
        } else {
            value < self.high
        };
        above && below
    }

    /// Can NO value be inside it?
    ///
    /// `low > high` is the reversed band; `low == high` is a single point, which
    /// is a legal (if strange) band only while both ends are inclusive. Left
    /// unchecked, either one judges every value unfavourable forever - the exact
    /// mirror of the empty date range validate.rs has always refused.
    pub fn is_empty(&self) -> bool {
        self.low > self.high
            || (self.low == self.high && !(self.low_inclusive && self.high_inclusive))
    }

    /// `[90000, 140000]`, with a round bracket for an excluded end - the
    /// interval notation, so provenance can quote a band without a sentence.
    pub fn label(&self) -> String {
        format!(
            "{}{}, {}{}",
            if self.low_inclusive { "[" } else { "(" },
            self.low,
            self.high,
            if self.high_inclusive { "]" } else { ")" }
        )
    }
}

impl Target {
    /// A band with both ends included, which is what a person writing
    /// `{"type": "band", "low": 90000, "high": 140000}` gets.
    pub fn band(low: f64, high: f64) -> Self {
        Target::Band {
            low,
            high,
            low_inclusive: true,
            high_inclusive: true,
        }
    }

    /// The bounds, when this target is a band.
    pub fn as_band(&self) -> Option<BandBounds> {
        match self {
            Target::Band {
                low,
                high,
                low_inclusive,
                high_inclusive,
            } => Some(BandBounds {
                low: *low,
                high: *high,
                low_inclusive: *low_inclusive,
                high_inclusive: *high_inclusive,
            }),
            _ => None,
        }
    }
}

/// The floor below which a movement is not worth saying out loud.
///
/// Internally tagged for the same readability reason as `Target`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Materiality {
    /// In the measure's own unit.
    Absolute { value: f64 },
    /// A fraction of the baseline, e.g. 0.02 for two percent.
    Relative { value: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cadence {
    Daily,
    Weekly,
    Monthly,
    Quarterly,
    Yearly,
}

/// What a column is FOR, which decides whether it may scope a rule or slice a
/// fact. Keys and labels can do neither: slicing revenue by invoice id produces
/// one fact per invoice and says nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Key,
    Analysis,
    Label,
    Filter,
    Hierarchy,
    Ignore,
}

impl Role {
    /// Roles a rule scope and a fact slice may name.
    pub fn may_scope(self) -> bool {
        matches!(self, Role::Analysis | Role::Filter | Role::Hierarchy)
    }
}

/// Who put this entry here.
///
/// `reviewed` answers "has a person signed this off"; it cannot tell a machine's
/// guess from a person's statement from an entry nobody has ever filled in. The
/// Strategy tab was showing an "inferred" badge next to a Confirm button on rows
/// where every value was absent, so Confirm did nothing and taught people to
/// click it without reading. An absent `source` is the third state: untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntrySource {
    /// Written by `infer`, from the model and the workbook's own usage.
    Inferred,
    /// Typed by a person.
    Authored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableKind {
    Fact,
    Dimension,
    Bridge,
    Calendar,
    Other,
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/// One column's constraint inside a scope.
///
/// UNTAGGED, so a member list is written as the bare array a person reaches for
/// — `{"Product[Category]": ["Gadgets"]}` — rather than serde's default
/// `{"Product[Category]": {"members": ["Gadgets"]}}`. A list of members and an
/// object with `from`/`to` cannot be confused for each other, so the untagged
/// form is unambiguous as well as readable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, rename_all = "camelCase")]
pub enum ScopeValue {
    Members(Vec<String>),
    /// Inclusive ISO-8601 `YYYY-MM-DD` bounds. `to` may be omitted, which means
    /// "from this date onwards" — the way a business rule is actually stated
    /// ("the Nordics floor took effect in 2025"), and the way it stays true
    /// when next year's data arrives.
    ///
    /// The format is not cosmetic. overlap.rs compares these bounds as STRINGS,
    /// which is exact for zero-padded ISO-8601 and wrong for anything else, so
    /// validate.rs refuses a malformed bound as an error rather than letting the
    /// overlap checker quietly conclude "disjoint".
    DateRange {
        from: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },
}

impl ScopeValue {
    /// An inclusive range with both bounds.
    pub fn between(from: impl Into<String>, to: impl Into<String>) -> Self {
        ScopeValue::DateRange {
            from: from.into(),
            to: Some(to.into()),
        }
    }

    /// An open-ended range: everything from `from` onwards.
    pub fn from_onwards(from: impl Into<String>) -> Self {
        ScopeValue::DateRange {
            from: from.into(),
            to: None,
        }
    }
}

/// A finite region of the analysis space: column -> allowed members.
///
/// A column absent from the map is UNCONSTRAINED, which is why `{Dept: [A]}` and
/// `{Region: [Nordics]}` intersect - both admit the point (Dept=A, Region=Nordics).
pub type Scope = BTreeMap<QualifiedColumn, ScopeValue>;

// ---------------------------------------------------------------------------
// The attribute set a rule may set - and nothing more
// ---------------------------------------------------------------------------

/// The one and only payload a `Rule` may carry.
///
/// Read the module header before adding a field. Every member here either
/// reinterprets a number the model computed, removes a fact kind, or reorders
/// ranking. None of them can introduce a number.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttributeSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materiality: Option<Materiality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence: Option<Cadence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation: Option<AggregationSpec>,
    /// Fact KINDS to withhold in this scope (e.g. `"contribution"`, `"trend"`).
    /// It can only take facts away.
    ///
    /// SPELLED EXACTLY AS ONE OF `SUPPRESSIBLE_FACT_KINDS`. The engine matches
    /// these against `ModelFactKind::kind_key`, so a near-miss withholds nothing
    /// and the fact the author asked to hide is PUBLISHED. This very comment
    /// used to give `"outlier"` as its example, and it was wrong twice over:
    /// the core engine's own key for that fact is the PLURAL `"outliers"`, and
    /// a model run never wraps an outlier fact anyway - so the one place a
    /// person would copy a spelling from named something that could not be
    /// suppressed under either spelling. validate.rs refuses an unknown key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suppress: Vec<String>,
    /// Multiplier on this measure's ranking score in this scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank_weight: Option<f64>,
}

/// The attributes a rule can address, as a first-class value.
///
/// overlap.rs groups conflicts by attribute and resolve.rs layers attribute by
/// attribute, so this enum is the axis both of them iterate; a new member of
/// `AttributeSet` that is not added here is invisible to BOTH, which is why
/// `AttributeSet::touched` is written as an exhaustive match rather than a list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Attribute {
    Direction,
    Target,
    Materiality,
    Cadence,
    Aggregation,
    Suppress,
    RankWeight,
}

impl fmt::Display for Attribute {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Attribute::Direction => "direction",
            Attribute::Target => "target",
            Attribute::Materiality => "materiality",
            Attribute::Cadence => "cadence",
            Attribute::Aggregation => "aggregation",
            Attribute::Suppress => "suppress",
            Attribute::RankWeight => "rankWeight",
        };
        f.write_str(s)
    }
}

impl AttributeSet {
    /// Which attributes this set actually addresses.
    ///
    /// Written as a destructuring match on purpose: adding a field to
    /// `AttributeSet` without deciding what it means here is a COMPILE ERROR,
    /// which is the only reliable way to keep the overlap checker honest.
    pub fn touched(&self) -> Vec<Attribute> {
        let AttributeSet {
            direction,
            target,
            materiality,
            cadence,
            aggregation,
            suppress,
            rank_weight,
        } = self;
        let mut out = Vec::new();
        if direction.is_some() {
            out.push(Attribute::Direction);
        }
        if target.is_some() {
            out.push(Attribute::Target);
        }
        if materiality.is_some() {
            out.push(Attribute::Materiality);
        }
        if cadence.is_some() {
            out.push(Attribute::Cadence);
        }
        if aggregation.is_some() {
            out.push(Attribute::Aggregation);
        }
        if !suppress.is_empty() {
            out.push(Attribute::Suppress);
        }
        if rank_weight.is_some() {
            out.push(Attribute::RankWeight);
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.touched().is_empty()
    }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/// Model-wide defaults.
///
/// It carries `reviewed`/`source` for the same reason every measure and table
/// entry does, and one of its four fields is the reason it matters most:
/// `defaultTimeAxis` may be a GUESS - `facts.rs` infers a calendar when nobody
/// marked one - and a guessed calendar drives every trend, seasonality and
/// change-point claim in the report. Without a badge and a Confirm on this
/// block, that guess is the one thing in the document a person cannot accept.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelStrategy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_time_axis: Option<QualifiedColumn>,
    /// `MM-DD`, e.g. `"04-01"` for an April fiscal year.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiscal_year_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reporting_currency: Option<String>,
    /// Measure names, most important first. Ties in ranking break by this order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub priority: Vec<String>,
    /// Has a human confirmed this block? BLOCK-LEVEL: one badge for four
    /// fields, which is the same granularity a measure row already has.
    #[serde(default)]
    pub reviewed: bool,
    /// Who wrote this block. Absent means nobody has - see `EntrySource`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<EntrySource>,
}

/// Everything the strategy says about one measure, outside any scope.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasureStrategy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation: Option<AggregationSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<Unit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materiality: Option<Materiality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence: Option<Cadence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u32>,
    /// Columns worth breaking this measure down by.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub analysis_dimensions: Vec<QualifiedColumn>,
    /// Columns that must never appear in a fact about this measure - the
    /// meaningless (invoice id) and the sensitive (employee name) alike.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub never_slice_by: Vec<QualifiedColumn>,
    /// PROSE. Reaches the narrative layer's wording and nothing else. It cannot
    /// change which facts exist or how they rank.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Has a human confirmed this entry? A generated draft is `false` and the
    /// validator warns until someone looks at it.
    #[serde(default)]
    pub reviewed: bool,
    /// Who wrote this entry. Absent means nobody has - see `EntrySource`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<EntrySource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnStrategy {
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableStrategy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<TableKind>,
    /// The column a reader recognises a row by ("Product Name", not "ProductKey").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_column: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub columns: BTreeMap<String, ColumnStrategy>,
    /// Coarse-to-fine column chains, e.g. `[["Country", "Region", "City"]]`.
    ///
    /// A COPY of the model's own hierarchies when `infer` wrote it, and a place
    /// to state one the model does not declare otherwise. Validation reads the
    /// UNION of this and `TableFacts::hierarchies`, so neither source can hide a
    /// level from the other.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hierarchies: Vec<Vec<String>>,
    #[serde(default)]
    pub reviewed: bool,
    /// Who wrote this entry. Absent means nobody has - see `EntrySource`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<EntrySource>,
}

/// A scoped override. It ANNOTATES facts; it cannot generate one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub measure: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scope: Scope,
    pub set: AttributeSet,
    /// PROSE. Wording only - see the module header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// "Q3 2025 was the ERP cutover." Pure prose attached to a region.
///
/// It has no `set` at all, which is the structural reason a period annotation can
/// never change which facts appear: it is the wording channel, full stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeriodAnnotation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measure: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scope: Scope,
    pub note: String,
}

/// The hypothetical movement an inline test asks the resolver to judge.
///
/// A test states a movement it INVENTS; it never claims the model contains one.
/// That is why this lives on `StrategyTest` and not anywhere near `AttributeSet`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestGiven {
    /// Signed movement in the measure's own unit.
    pub delta: f64,
    /// The observed value, needed only to judge a `TargetBand` direction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// What `delta` was measured from, needed only for relative materiality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExpectedStatus {
    Favourable,
    Unfavourable,
    Neutral,
    /// The engine must say nothing about favourability here.
    Suppressed,
}

impl fmt::Display for ExpectedStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ExpectedStatus::Favourable => "favourable",
            ExpectedStatus::Unfavourable => "unfavourable",
            ExpectedStatus::Neutral => "neutral",
            ExpectedStatus::Suppressed => "suppressed",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestExpect {
    pub status: ExpectedStatus,
    /// Optionally, the rule id that must be the one that decided it. This is what
    /// turns "the answer happens to be right" into "the answer is right for the
    /// reason I intended".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
}

/// A consultant's own assertion about their file, run by the validator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrategyTest {
    pub measure: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scope: Scope,
    pub given: TestGiven,
    pub expect: TestExpect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrategyDoc {
    pub version: u32,
    #[serde(default)]
    pub model: ModelStrategy,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub measures: BTreeMap<String, MeasureStrategy>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tables: BTreeMap<String, TableStrategy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<Rule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periods: Vec<PeriodAnnotation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<StrategyTest>,
}

impl Default for StrategyDoc {
    fn default() -> Self {
        Self {
            version: STRATEGY_DOC_VERSION,
            model: ModelStrategy::default(),
            measures: BTreeMap::new(),
            tables: BTreeMap::new(),
            rules: Vec::new(),
            periods: Vec::new(),
            tests: Vec::new(),
        }
    }
}

impl StrategyDoc {
    /// The declared role of a column, if the document declares one.
    pub fn role_of(&self, col: &QualifiedColumn) -> Option<Role> {
        self.tables
            .get(&col.table)
            .and_then(|t| t.columns.get(&col.column))
            .map(|c| c.role)
    }

    /// Does any declared hierarchy in the column's table name it?
    ///
    /// A column can earn the right to scope a rule either by declaring
    /// `role: hierarchy` or by appearing in a hierarchy chain; requiring both
    /// would reject the ordinary case where the chain IS the declaration.
    pub fn in_a_hierarchy(&self, col: &QualifiedColumn) -> bool {
        self.tables
            .get(&col.table)
            .map(|t| t.hierarchies.iter().any(|h| h.iter().any(|c| c == &col.column)))
            .unwrap_or(false)
    }

    /// May this column constrain a rule scope or slice a fact?
    pub fn may_scope(&self, col: &QualifiedColumn) -> bool {
        match self.role_of(col) {
            Some(role) => role.may_scope() || self.in_a_hierarchy(col),
            // Undeclared is not refused: the strategy file is allowed to be
            // partial, and refusing every undeclared column would make an empty
            // `tables` section reject every rule in the document. validate.rs
            // warns instead.
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_qualified_column_prints_and_parses_as_table_bracket_column() {
        let qc = QualifiedColumn::new("Sales", "Region");
        assert_eq!(qc.to_string(), "Sales[Region]");
        assert_eq!(QualifiedColumn::from_str("Sales[Region]").unwrap(), qc);
    }

    #[test]
    fn a_qualified_column_keeps_spaces_inside_both_halves() {
        let qc = QualifiedColumn::from_str("Sales Orders[Order Date]").unwrap();
        assert_eq!(qc.table, "Sales Orders");
        assert_eq!(qc.column, "Order Date");
    }

    #[test]
    fn a_malformed_qualified_column_reports_why_rather_than_guessing() {
        for (input, needle) in [
            ("Sales", "no '['"),
            ("Sales[Region", "does not end with ']'"),
            ("[Region]", "table name is empty"),
            ("Sales[]", "column name is empty"),
            ("Sales[Re[gion]", "contains a bracket"),
        ] {
            let err = QualifiedColumn::from_str(input).unwrap_err();
            assert!(
                err.to_string().contains(needle),
                "'{input}' should have reported '{needle}', reported '{err}'"
            );
        }
    }

    #[test]
    fn a_qualified_column_serializes_as_a_bare_string_so_it_can_be_a_map_key() {
        let mut scope: Scope = Scope::new();
        scope.insert(
            QualifiedColumn::new("Dim", "Dept"),
            ScopeValue::Members(vec!["A".into()]),
        );
        let json = serde_json::to_string(&scope).unwrap();
        // The column is a bare string BECAUSE it is a map key, and the member
        // list is a bare array because `ScopeValue` is untagged. Together those
        // give the form a person actually writes; this test pins both, because
        // this document is hand-authored and its wire shape is part of its
        // contract with the people who write it.
        assert_eq!(json, r#"{"Dim[Dept]":["A"]}"#);
        let back: Scope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, scope);
    }

    #[test]
    fn an_open_ended_date_range_round_trips_and_omits_its_missing_end() {
        // "The Nordics floor took effect in 2025" has no end date, and writing
        // one in would make the rule quietly stop applying next year.
        let mut scope: Scope = Scope::new();
        scope.insert(
            QualifiedColumn::new("Date", "Date"),
            ScopeValue::from_onwards("2025-01-01"),
        );
        let json = serde_json::to_string(&scope).unwrap();
        assert_eq!(json, r#"{"Date[Date]":{"from":"2025-01-01"}}"#);
        assert_eq!(serde_json::from_str::<Scope>(&json).unwrap(), scope);

        let closed = r#"{"Date[Date]":{"from":"2025-01-01","to":"2025-06-30"}}"#;
        assert_eq!(
            serde_json::from_str::<Scope>(closed).unwrap()[&QualifiedColumn::new("Date", "Date")],
            ScopeValue::between("2025-01-01", "2025-06-30")
        );
    }

    #[test]
    fn an_unknown_field_anywhere_in_the_document_is_an_error_not_a_shrug() {
        // The whole point of deny_unknown_fields: a typo must not parse.
        let json = r#"{
            "version": 1,
            "measures": { "Revenue": { "direktion": "higherIsBetter" } }
        }"#;
        let err = serde_json::from_str::<StrategyDoc>(json).unwrap_err();
        assert!(
            err.to_string().contains("direktion"),
            "the error should quote the typo, said: {err}"
        );
    }

    #[test]
    fn a_minimal_document_needs_only_a_version() {
        let doc: StrategyDoc = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert_eq!(doc.version, 1);
        assert!(doc.rules.is_empty());
        assert!(doc.measures.is_empty());
    }

    #[test]
    fn a_target_measure_reference_uses_the_wire_name_ref() {
        let t = Target::Measure {
            r#ref: "Budget".into(),
        };
        // Internally tagged, so the discriminant reads as a field. The raw
        // identifier keeps the wire name `ref` without a per-field serde
        // rename, which house rules forbid.
        assert_eq!(serde_json::to_string(&t).unwrap(), r#"{"type":"measure","ref":"Budget"}"#);
        assert_eq!(
            serde_json::to_string(&Target::Kpi).unwrap(),
            r#"{"type":"kpi"}"#,
            "a unit variant still carries its tag, so `target` is never a bare string"
        );
        assert_eq!(
            serde_json::to_string(&Materiality::Absolute { value: 2.5 }).unwrap(),
            r#"{"type":"absolute","value":2.5}"#
        );
    }

    #[test]
    fn the_document_round_trips_through_json_unchanged() {
        let mut doc = StrategyDoc::default();
        doc.model.priority = vec!["Revenue".into()];
        doc.measures.insert(
            "Revenue".into(),
            MeasureStrategy {
                direction: Some(Direction::HigherIsBetter),
                unit: Some(Unit::Currency),
                materiality: Some(Materiality::Relative { value: 0.02 }),
                context: Some("Net of returns.".into()),
                reviewed: true,
                ..Default::default()
            },
        );
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Revenue".into(),
            scope: Scope::new(),
            set: AttributeSet {
                direction: Some(Direction::LowerIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let json = serde_json::to_string(&doc).unwrap();
        let back: StrategyDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn an_entry_source_is_optional_on_the_wire_and_absent_means_untouched() {
        // A document written before `source` existed must still parse under
        // `deny_unknown_fields`, and an entry nobody has written must be
        // distinguishable from one a machine guessed.
        let doc: StrategyDoc = serde_json::from_str(
            r#"{"version":1,"measures":{"Revenue":{"reviewed":true}},"tables":{"Dim":{}}}"#,
        )
        .unwrap();
        assert_eq!(doc.measures["Revenue"].source, None);
        assert_eq!(doc.tables["Dim"].source, None);

        let mut stamped = MeasureStrategy::default();
        stamped.source = Some(EntrySource::Inferred);
        assert_eq!(
            serde_json::to_string(&stamped).unwrap(),
            r#"{"reviewed":false,"source":"inferred"}"#
        );
        // ...and an absent source writes NO key at all, so "untouched" is a state
        // the JSON can express rather than one it fakes with a default.
        assert_eq!(
            serde_json::to_string(&MeasureStrategy::default()).unwrap(),
            r#"{"reviewed":false}"#
        );
    }

    #[test]
    fn an_attribute_set_reports_exactly_the_attributes_it_addresses() {
        let empty = AttributeSet::default();
        assert!(empty.touched().is_empty());
        assert!(empty.is_empty());

        let set = AttributeSet {
            direction: Some(Direction::LowerIsBetter),
            // A kind the engine really emits: the example in this file used to
            // be `"outlier"`, which nothing carries under any spelling.
            suppress: vec!["contribution".into()],
            rank_weight: Some(2.0),
            ..Default::default()
        };
        assert_eq!(
            set.touched(),
            vec![Attribute::Direction, Attribute::Suppress, Attribute::RankWeight]
        );
    }

    #[test]
    fn only_analysis_filter_and_hierarchy_roles_may_scope_a_rule() {
        assert!(Role::Analysis.may_scope());
        assert!(Role::Filter.may_scope());
        assert!(Role::Hierarchy.may_scope());
        assert!(!Role::Key.may_scope());
        assert!(!Role::Label.may_scope());
        assert!(!Role::Ignore.may_scope());
    }

    #[test]
    fn a_band_written_without_inclusivity_includes_both_ends_and_serializes_back_unchanged() {
        // The wire shape a person writes, and the one the checked-in corpus
        // uses. `#[serde(default)]` on a bool would have made an unmentioned
        // bound EXCLUSIVE, which is the opposite of what `low: 90000` means.
        let t: Target = serde_json::from_str(r#"{"type":"band","low":90000,"high":140000}"#).unwrap();
        assert_eq!(t, Target::band(90000.0, 140000.0));
        let band = t.as_band().expect("a band reports its bounds");
        assert!(band.low_inclusive && band.high_inclusive);
        assert!(band.contains(90000.0) && band.contains(140000.0));
        // ...and it writes back the way it was written, with no two keys added
        // to every hand-authored document.
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"type":"band","low":90000.0,"high":140000.0}"#
        );
    }

    #[test]
    fn an_excluded_bound_survives_the_round_trip_and_changes_what_the_band_contains() {
        let json = r#"{"type":"band","low":0.0,"high":1.0,"highInclusive":false}"#;
        let t: Target = serde_json::from_str(json).unwrap();
        let band = t.as_band().unwrap();
        assert!(band.low_inclusive, "the bound nobody mentioned stays inclusive");
        assert!(!band.high_inclusive);
        assert!(band.contains(0.0), "the included end is inside");
        assert!(!band.contains(1.0), "the excluded end is not");
        assert!(band.contains(0.999));
        // Only the bound that is NOT the default is written out, so the document
        // stays as small as the statement it makes.
        assert_eq!(serde_json::to_string(&t).unwrap(), json);
        assert_eq!(band.label(), "[0, 1)");
    }

    #[test]
    fn a_reversed_or_pointlike_band_is_recognised_as_one_no_value_can_satisfy() {
        // Unchecked, every one of these judges every value unfavourable forever.
        assert!(Target::band(140000.0, 90000.0).as_band().unwrap().is_empty());
        assert!(!Target::band(5.0, 5.0).as_band().unwrap().is_empty(), "a single point is legal");
        let half_open = Target::Band {
            low: 5.0,
            high: 5.0,
            low_inclusive: true,
            high_inclusive: false,
        };
        assert!(
            half_open.as_band().unwrap().is_empty(),
            "a single point with an excluded end admits nothing"
        );
        assert!(!Target::band(90000.0, 140000.0).as_band().unwrap().is_empty());
    }

    #[test]
    fn the_suppressible_fact_kinds_are_sorted_unique_and_spelled_the_way_the_engine_emits_them() {
        // The list is a CONTRACT with the person writing the document: they copy
        // a spelling out of it. Sorted and unique so a diff of it reads.
        //
        // Neither spelling of the example this file used to give is in it. A
        // model run wraps only three of `core/insights`' series facts, so
        // `outlier` (the typo) and `outliers` (the core engine's real key) are
        // BOTH unsuppressible here - which is exactly why the list is a list and
        // not a sentence. That it matches the emitter is proved in
        // `insights::model`, where the emitter lives.
        let mut sorted = SUPPRESSIBLE_FACT_KINDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.as_slice(), SUPPRESSIBLE_FACT_KINDS);
        assert!(!SUPPRESSIBLE_FACT_KINDS.contains(&"outlier"));
        assert!(!SUPPRESSIBLE_FACT_KINDS.contains(&"outliers"));
    }

    #[test]
    fn the_model_block_carries_the_same_reviewed_and_source_badge_every_other_row_does() {
        // `defaultTimeAxis` can be an inferred calendar, and an inferred
        // calendar drives every trend claim in the report. Without these two
        // fields the panel has no badge to show and no Confirm to offer on the
        // one block where a guess most needs accepting.
        let doc: StrategyDoc = serde_json::from_str(
            r#"{"version":1,"model":{"fiscalYearStart":"04-01"}}"#,
        )
        .unwrap();
        assert!(!doc.model.reviewed, "a block nobody wrote is not reviewed");
        assert_eq!(doc.model.source, None, "and nobody has touched it");

        let stamped = ModelStrategy {
            default_time_axis: Some(QualifiedColumn::new("Date", "Date")),
            reviewed: false,
            source: Some(EntrySource::Inferred),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&stamped).unwrap(),
            r#"{"defaultTimeAxis":"Date[Date]","reviewed":false,"source":"inferred"}"#
        );
    }

    #[test]
    fn a_column_named_by_a_hierarchy_may_scope_even_when_its_role_says_label() {
        let mut doc = StrategyDoc::default();
        doc.tables.insert(
            "Geo".into(),
            TableStrategy {
                columns: BTreeMap::from([(
                    "Country".to_string(),
                    ColumnStrategy {
                        role: Role::Label,
                        priority: None,
                    },
                )]),
                hierarchies: vec![vec!["Country".into(), "City".into()]],
                ..Default::default()
            },
        );
        assert!(doc.may_scope(&QualifiedColumn::new("Geo", "Country")));

        // ...but a plain label that no hierarchy names may not.
        doc.tables.get_mut("Geo").unwrap().hierarchies.clear();
        assert!(!doc.may_scope(&QualifiedColumn::new("Geo", "Country")));
    }
}
