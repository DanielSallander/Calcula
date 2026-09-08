//! FILENAME: app/src-tauri/src/insights/strategy/facts.rs
// PURPOSE: Read a semantic model down to the handful of facts the resolver and
//          the validator actually need.
// CONTEXT: `resolve.rs` and `validate.rs` deliberately take a `ModelFacts`
//          rather than a `DataModel`. That is not indirection for its own sake:
//          it is what lets the whole strategy layer be tested with a struct
//          literal, with no DataFusion in the dependency tree and no query
//          engine to stand up. This file is the ONLY place that knows both
//          shapes, so it is the only place a change in the BI engine's model
//          API can reach the strategy layer.
//
//          THE BASE LAYER IS BUILT HERE. Everything `AttrSource::Base` and
//          `AttrSource::Inferred` later claims comes from what this file
//          extracts — the KPI's target and its bands' STATUSES, the unit implied
//          by a format string AND by the measure's name, which table is the
//          calendar, which columns exist, which hierarchies the model declares.
//          Extracting one of them wrongly does not produce an error; it
//          produces a confidently wrong favourability, which is why each
//          derivation below states what it assumes.
//
//          ONE OF THOSE DERIVATIONS IS NOW A GUESS, AND IT SAYS SO.
//          `mark_date_table` is builder-only, so an ordinary imported star
//          schema arrives with no calendar at all — and without one there is no
//          default time axis, no `TableKind::Calendar` and no role for a
//          `Decimal` month column, which switches off the whole time-series half
//          of the engine in silence. `infer_date_table` fills that in when the
//          shape is unmistakable and REFUSES when two tables qualify;
//          `ModelFacts::calendar_source` carries whether the answer was declared
//          or guessed, and the planner announces the difference.

use std::collections::{BTreeMap, BTreeSet};

use bi_engine::{Cardinality, DataModel, DataType, DateRole, KpiStatus, KpiTarget};

use super::infer::{has_phrase, has_term, words};
use super::resolve::{
    BandStatus, CalendarSource, KpiBand, KpiFacts, MeasureFacts, ModelFacts, TableFacts,
};
use super::types::{QualifiedColumn, TableKind, Unit};

/// Read a model into the facts the strategy layer resolves against.
pub fn facts_from_model(model: &DataModel) -> ModelFacts {
    let mut facts = ModelFacts::default();

    // --- relationships ------------------------------------------------------
    // Only ACTIVE relationships. An inactive one exists for a `USERELATIONSHIP`
    // that the insights planner never issues, so treating it as reachable would
    // offer the user a breakdown the engine would refuse to compute.
    //
    // READ BEFORE THE CALENDAR, because the calendar inference below needs to
    // know which tables are the FROM side of a relationship: a table filters
    // flow out of is the grain of the model, and a grain is never a calendar.
    let mut is_from: BTreeSet<&str> = BTreeSet::new();
    let mut is_to: BTreeSet<&str> = BTreeSet::new();
    for rel in model.relationships() {
        if !rel.is_active() {
            continue;
        }
        is_from.insert(rel.from_table());
        // Only a to-one endpoint makes the far side a lookup. A many-to-many
        // relationship has no dimension side, and calling one of its ends a
        // dimension is how a bridge table ends up offered as an analysis axis.
        if matches!(rel.cardinality(), Cardinality::ManyToOne | Cardinality::OneToOne) {
            is_to.insert(rel.to_table());
        }
        for cond in rel.conditions() {
            facts.relationships.push((
                QualifiedColumn::new(rel.from_table(), cond.from_column()),
                QualifiedColumn::new(rel.to_table(), cond.to_column()),
            ));
        }
    }

    // --- the calendar -------------------------------------------------------
    // A DECLARATION ALWAYS WINS AND IS NEVER OVERRIDDEN. `mark_date_table` is
    // the author saying which table time runs along, and no heuristic here may
    // second-guess it — not even on a model where another table looks more like
    // a calendar than the marked one does.
    let (date_table, calendar_source) = match model.date_table() {
        Some(declared) => (Some(declared.to_string()), Some(CalendarSource::Declared)),
        None => match infer_date_table(model, &is_from) {
            Some(guessed) => (Some(guessed), Some(CalendarSource::Inferred)),
            None => (None, None),
        },
    };
    facts.date_table = date_table;
    facts.calendar_source = calendar_source;

    // --- tables -------------------------------------------------------------
    for table in model.tables() {
        let name = table.name();
        let columns: BTreeSet<String> = table.columns().iter().map(|c| c.name().to_string()).collect();
        facts.tables.insert(
            name.to_string(),
            TableFacts {
                kind: Some(classify_table(
                    name,
                    facts.date_table.as_deref(),
                    is_from.contains(name),
                    is_to.contains(name),
                )),
                columns,
                // The model's own hierarchies, level order preserved. Validation
                // reads them from HERE rather than from the strategy document's
                // copy, so a document nobody has run inference over still gets
                // its hierarchy levels recognised as scopable.
                hierarchies: model
                    .hierarchies_for_table(name)
                    .iter()
                    .map(|h| h.levels().iter().map(|l| l.column().to_string()).collect())
                    .collect(),
                // Members are DATA, not schema. Filling this in means running a
                // grouped query per column, which the strategy layer must not
                // do on every validation. The resolver reads an absent entry as
                // "the member list is not known", which is the honest state and
                // makes it decline to prove full coverage rather than assume it.
                members: BTreeMap::new(),
            },
        );
    }

    // --- KPIs, indexed by the measure they mark up --------------------------
    let mut kpis: BTreeMap<&str, KpiFacts> = BTreeMap::new();
    for kpi in model.kpis() {
        kpis.insert(
            kpi.base_measure(),
            KpiFacts {
                name: kpi.name().to_string(),
                target: match kpi.target() {
                    KpiTarget::Constant(v) => Some(*v),
                    // A measure-valued target is a number only once a query has
                    // run, so it is genuinely unknown here. `None` keeps the
                    // validator from comparing against a value it invented.
                    KpiTarget::Measure(_) => None,
                },
                // THE STATUS COMES ACROSS WITH THE THRESHOLD. The threshold order
                // is validated ascending by the engine's own builder, so a
                // strategy layer that carried thresholds alone could only ever
                // conclude "higher is better" - including for a churn KPI whose
                // every band says the opposite.
                bands: kpi
                    .status_bands()
                    .iter()
                    .map(|b| KpiBand::new(b.threshold, band_status(b.status)))
                    .collect(),
            },
        );
    }

    // --- measures -----------------------------------------------------------
    for measure in model.measures() {
        facts.measures.insert(
            measure.name().to_string(),
            MeasureFacts {
                fact_table: Some(measure.table().to_string()),
                unit: infer_unit(measure.name(), measure.format_string()),
                kpi: kpis.get(measure.name()).cloned(),
            },
        );
    }

    facts
}

/// The engine's `KpiStatus` in the strategy layer's own vocabulary.
///
/// Written as a total match rather than a `From` on a foreign type: a new status
/// level in the engine must be a COMPILE ERROR here, because a status silently
/// folded into the wrong bucket flips a direction.
fn band_status(status: KpiStatus) -> BandStatus {
    match status {
        KpiStatus::OffTrack => BandStatus::OffTrack,
        KpiStatus::AtRisk => BandStatus::AtRisk,
        KpiStatus::OnTrack => BandStatus::OnTrack,
    }
}

// ---------------------------------------------------------------------------
// Which table is the calendar
// ---------------------------------------------------------------------------

/// Words that name a PART of a calendar, matched by WORD EQUALITY through the
/// same splitter the rest of the lexicons use.
///
/// Bilingual for the same reason every other lexicon in this layer is: a Swedish
/// model is the normal case here, not an edge case. The joined spellings
/// (`dayofweek`, `weekofyear`, `monthname`) are listed because `words()` cannot
/// split a name that carries no case change, space or separator.
const CALENDAR_PART_WORDS: &[&str] = &[
    "year",
    "quarter",
    "month",
    "week",
    "day",
    "dayofweek",
    "weekday",
    "monthname",
    "dayname",
    "weekofyear",
    "år",
    "kvartal",
    "månad",
    "vecka",
    "dag",
];

/// How many of a table's columns must read as calendar parts before it can be
/// guessed as the calendar.
///
/// TWO, because one is an ordinary attribute. A customer dimension carrying a
/// `BirthYear` is not a calendar; a table carrying a year AND a month is one
/// shape and one shape only. It is the cheapest guard against the failure mode
/// that matters — a WRONGLY chosen calendar is worse than none, because every
/// trend, change point and seasonality fact in the run is then computed against
/// an axis that is not time.
const MIN_CALENDAR_PART_COLUMNS: usize = 2;

/// Does this column name read as a calendar part?
fn names_a_calendar_part(column: &str) -> bool {
    let w = words(column);
    CALENDAR_PART_WORDS.iter().any(|t| has_term(&w, t))
}

/// The table that IS a calendar on a model whose author never marked one.
///
/// WHY THIS EXISTS AT ALL. `mark_date_table` is builder-only; an ordinary
/// imported star schema arrives with no mark, and without a `date_table` the
/// whole time-series half of the engine is switched off in silence: there is no
/// default time axis, so trend, seasonality and change-point facts have nothing
/// to compute against; `classify_table` never answers `Calendar`, so the role
/// ladder's calendar arm never fires; and `year`/`quarter`/`month`/`day` fall
/// through the String|Int allowlist to no role at all when a warehouse types
/// them `Decimal`. One rule here unlocks all of it.
///
/// THE DETECTION IS DELIBERATELY CONSERVATIVE, and every clause below is a
/// refusal rather than a preference:
///
///   * NEVER A FACT TABLE. A table filters flow OUT of is the grain of the
///     model, and a fact table with an order-date column is exactly the thing a
///     laxer rule would seize on.
///   * IT MUST ACTUALLY CARRY A DATE. A `Date`/`Timestamp` column, or a column
///     the author declared `DateKey`. A table of month names and years with no
///     date in it cannot be a time axis.
///   * IT MUST READ AS A CALENDAR, in at least `MIN_CALENDAR_PART_COLUMNS` of
///     its column names.
///   * AMBIGUITY REFUSES. Two qualifying tables (a role-playing order-date and
///     ship-date pair, say) means the choice is a business decision. Picking one
///     silently is the confident-wrong this layer exists to avoid, so it infers
///     NOTHING and the model keeps no calendar at all.
///
/// Everything it does infer is stamped `CalendarSource::Inferred`, and the
/// planner says so out loud when it plots a series against it.
fn infer_date_table(model: &DataModel, is_from: &BTreeSet<&str>) -> Option<String> {
    let mut found: Option<String> = None;
    for table in model.tables() {
        let name = table.name();
        if is_from.contains(name) {
            continue;
        }
        let carries_a_date = table.columns().iter().any(|c| {
            matches!(c.data_type(), DataType::Date | DataType::Timestamp)
                || c.date_role() == Some(DateRole::DateKey)
        });
        if !carries_a_date {
            continue;
        }
        let parts = table
            .columns()
            .iter()
            .filter(|c| names_a_calendar_part(c.name()))
            .count();
        if parts < MIN_CALENDAR_PART_COLUMNS {
            continue;
        }
        if found.is_some() {
            // A SECOND CANDIDATE ENDS THE SEARCH OUTRIGHT. Returning the first
            // would make the answer depend on table declaration order, which is
            // the worst possible way to decide what time means in a report.
            return None;
        }
        found = Some(name.to_string());
    }
    found
}

/// What a table is FOR, from its position in the relationship graph.
///
/// This is inference, not a declaration: the engine has no table-kind field.
/// The strategy document can override every one of these, and the Strategy tab
/// shows them as unreviewed until somebody confirms them.
fn classify_table(name: &str, date_table: Option<&str>, from_side: bool, to_side: bool) -> TableKind {
    if date_table == Some(name) {
        return TableKind::Calendar;
    }
    match (from_side, to_side) {
        // Filters flow out of it and nothing looks it up: the grain of the model.
        (true, false) => TableKind::Fact,
        // Looked up and looks nothing up: a leaf dimension.
        (false, true) => TableKind::Dimension,
        // Both — a snowflake intermediate or a many-to-many bridge. Either way
        // it is not a leaf dimension, and v1's single-hop decomposition cannot
        // reach through it, so naming it Bridge is what makes the validator able
        // to report an attribute behind it as unreachable instead of dropping it.
        (true, true) => TableKind::Bridge,
        (false, false) => TableKind::Other,
    }
}

/// The part of a format string that carries meaning rather than decoration.
///
/// A literal escaped percent (`\%`) or one inside quotes is decoration, not a
/// scale factor. Strip both before looking, or `#,##0" %"` reads as percent and
/// the value is reported a hundred times too small.
fn significant_of(format: &str) -> String {
    let mut significant = String::with_capacity(format.len());
    let mut chars = format.chars();
    let mut in_quotes = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            _ if in_quotes => {}
            _ => significant.push(c),
        }
    }
    significant
}

/// The unit a format string states OUTRIGHT: a literal `%`, a currency bracket
/// or a currency symbol.
///
/// This is the half of the format reading that OUTRANKS the name lexicon.
/// Somebody typed those characters; a name is a label the same person chose for
/// a different purpose, and it does not get to overrule a written `%`.
fn explicit_unit_from_format(format: &str) -> Option<Unit> {
    let significant = significant_of(format);
    if significant.contains('%') {
        return Some(Unit::Percent);
    }
    // `[$SEK-41d]` and friends: the engine carries the currency inside a bracket
    // section, and a bare currency symbol is the older spelling.
    let lower = significant.to_ascii_lowercase();
    if lower.contains("[$")
        || significant.contains('$')
        || significant.contains('€')
        || significant.contains('£')
        || lower.contains("kr")
    {
        return Some(Unit::Currency);
    }
    None
}

/// The unit a number-format string implies, reading the format ALONE.
///
/// Deliberately conservative. `None` means "we could not tell", and the
/// downstream effect is that a sentence says the bare number — which is never
/// wrong, only less helpful. Guessing `Percent` at a format that is not one
/// produces a sentence that is off by a factor of a hundred.
fn unit_from_format(format: &str) -> Option<Unit> {
    if let Some(explicit) = explicit_unit_from_format(format) {
        return Some(explicit);
    }
    let significant = significant_of(format);
    // An integer format with no decimal separator is a count often enough to be
    // worth saying, and being wrong costs only a rounding style in a sentence.
    //
    // THIS IS THE AMBIGUOUS CASE, and it is where the name gets a vote:
    // `#,##0` is what a whole-krona Revenue measure is formatted with just as
    // often as a row count, and reading it as a count made a measure named
    // Revenue infer as a COUNT.
    if !significant.is_empty()
        && significant.chars().all(|c| matches!(c, '#' | '0' | ',' | ' ' | '_' | '-' | '(' | ')'))
        && !significant.contains('.')
    {
        return Some(Unit::Count);
    }
    None
}

// ---------------------------------------------------------------------------
// The name lexicon
// ---------------------------------------------------------------------------

/// Terms whose presence in a measure NAME means the number is money. Bilingual,
/// for the same reason infer.rs's direction lexicon is: a Swedish model is the
/// normal case here.
const CURRENCY_NAME_TERMS: &[&str] = &[
    "revenue",
    "sales",
    "cost",
    "price",
    "amount",
    "margin",
    "profit",
    "spend",
    "intäkt",
    "omsättning",
    "kostnad",
    "pris",
    "belopp",
];

/// Terms whose presence means the number is a proportion.
///
/// "margin percent" needs no phrase entry of its own: `percent` is a term here,
/// and percent is CHECKED BEFORE currency, so a measure named "Margin Percent"
/// answers Percent rather than being claimed by the `margin` above.
const PERCENT_NAME_TERMS: &[&str] = &["rate", "share", "ratio", "percent", "andel", "andelen"];

/// Terms whose presence means the number is a count. `headcount` is spelled out
/// because the word-boundary rule is exactly what stops `count` from matching
/// inside it — the same discipline that keeps "Costa Rica Sales" out of the cost
/// lexicon.
const COUNT_NAME_TERMS: &[&str] = &["count", "antal", "headcount"];

/// Phrases whose presence means a count, matched as CONSECUTIVE words.
const COUNT_NAME_PHRASES: &[&[&str]] = &[&["number", "of"]];

/// The unit a measure's NAME implies, or `None` when it says nothing.
///
/// Word boundaries, via the same splitter `infer_direction` uses: a substring
/// match makes "Costa Rica Sales" a cost measure and "Shareholder" a percentage.
///
/// ORDER: percent, then count, then currency. Percent leads because it is the
/// most specific vocabulary and the most expensive to lose - a ratio reported as
/// money is a sentence off by the magnitude of the base. Count leads currency so
/// that "Order Count" and "Sales Count" answer Count rather than being claimed by
/// the broad money vocabulary, which is the widest list here and would otherwise
/// swallow them.
fn unit_from_name(name: &str) -> Option<Unit> {
    let words = words(name);
    if PERCENT_NAME_TERMS.iter().any(|t| has_term(&words, t)) {
        return Some(Unit::Percent);
    }
    if COUNT_NAME_TERMS.iter().any(|t| has_term(&words, t))
        || COUNT_NAME_PHRASES.iter().any(|p| has_phrase(&words, p))
    {
        return Some(Unit::Count);
    }
    if CURRENCY_NAME_TERMS.iter().any(|t| has_term(&words, t)) {
        return Some(Unit::Currency);
    }
    None
}

/// The unit of one measure, from its format and its name.
///
/// THE PRECEDENCE IS THE WHOLE DESIGN, and it runs in this order:
///
/// 1. An EXPLICIT format signal - a literal `%`, a currency bracket or symbol.
///    A person who wrote the format meant it, and no name may overrule it: a
///    measure called "Revenue Share" formatted `0.0%` is a percentage.
/// 2. The NAME lexicon. It decides only where the format was AMBIGUOUS or
///    absent, which is exactly the case that produced the defect: `#,##0` on a
///    measure named Revenue was read as a COUNT, because an integer format is
///    the only thing the format reading had left to say.
/// 3. The format's ambiguous reading (integer-only means a count), for a name
///    that says nothing either way.
///
/// The DESCRIPTION is deliberately not consulted, unlike in `infer_direction`. A
/// name is the label the author chose for this number; a description is prose
/// ABOUT it, and it routinely mentions other quantities ("number of orders where
/// the amount exceeds...") that would answer for the measure itself.
fn infer_unit(name: &str, format: Option<&str>) -> Option<Unit> {
    if let Some(explicit) = format.and_then(explicit_unit_from_format) {
        return Some(explicit);
    }
    unit_from_name(name).or_else(|| format.and_then(unit_from_format))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::Direction;
    use bi_engine::{
        sum_measure, Column, DataType, Hierarchy, HierarchyLevel, Kpi, Relationship, StatusBand,
        Table,
    };

    /// Sales -> Product (many-to-one), Sales -> Date (many-to-one), Date marked.
    ///
    /// `kpi` is threaded through rather than added afterwards because the
    /// builder consumes itself and there is no "from an existing model" entry
    /// point; re-stating the star in three tests would be worse.
    fn a_small_star_with(kpi: Option<Kpi>) -> DataModel {
        let mut builder = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("ProductKey", DataType::Int64),
                        Column::new("Date", DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Product",
                    vec![
                        Column::new("ProductKey", DataType::Int64),
                        Column::new("Category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Date",
                    vec![
                        Column::new("Date", DataType::Date),
                        Column::new("Month", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Product",
                "Sales",
                "ProductKey",
                "Product",
                "ProductKey",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Date", "Sales", "Date", "Date", "Date",
            ))
            .mark_date_table("Date")
            .add_measure(sum_measure("Revenue", "Sales", "Amount"));
        if let Some(k) = kpi {
            builder = builder.add_kpi(k);
        }
        builder.build().expect("the fixture star schema builds")
    }

    fn a_small_star() -> DataModel {
        a_small_star_with(None)
    }

    #[test]
    fn the_marked_date_table_is_a_calendar_even_though_it_is_also_looked_up() {
        let facts = facts_from_model(&a_small_star());
        assert_eq!(facts.date_table.as_deref(), Some("Date"));
        assert_eq!(facts.tables["Date"].kind, Some(TableKind::Calendar));
    }

    #[test]
    fn the_from_side_is_the_fact_and_the_to_side_is_the_dimension() {
        let facts = facts_from_model(&a_small_star());
        assert_eq!(facts.tables["Sales"].kind, Some(TableKind::Fact));
        assert_eq!(facts.tables["Product"].kind, Some(TableKind::Dimension));
    }

    #[test]
    fn every_column_of_every_table_is_reachable_by_name() {
        let facts = facts_from_model(&a_small_star());
        assert!(facts.has_column(&QualifiedColumn::new("Product", "Category")));
        assert!(!facts.has_column(&QualifiedColumn::new("Product", "Colour")));
    }

    #[test]
    fn a_relationship_becomes_a_column_pair_the_resolver_can_walk() {
        let facts = facts_from_model(&a_small_star());
        let pair = (
            QualifiedColumn::new("Sales", "ProductKey"),
            QualifiedColumn::new("Product", "ProductKey"),
        );
        assert!(facts.relationships.contains(&pair), "{:?}", facts.relationships);
    }

    #[test]
    fn members_are_left_unknown_rather_than_reported_as_none() {
        // The distinction matters: an EMPTY member list would let the resolver
        // conclude a rule covers every member of a column, which is how a
        // mixed-direction suppression gets skipped and a wrong favourability
        // ships.
        let facts = facts_from_model(&a_small_star());
        assert!(facts
            .known_members(&QualifiedColumn::new("Product", "Category"))
            .is_none());
    }

    #[test]
    fn a_measure_carries_the_table_it_aggregates_over() {
        let facts = facts_from_model(&a_small_star());
        assert_eq!(
            facts.measures["Revenue"].fact_table.as_deref(),
            Some("Sales")
        );
    }

    #[test]
    fn a_kpis_target_and_band_statuses_reach_the_resolver() {
        let model = a_small_star_with(Some(
            Kpi::new("Revenue KPI", "Revenue", KpiTarget::Constant(1000.0))
                .with_status_band(StatusBand::new(0.8, KpiStatus::OffTrack))
                .with_status_band(StatusBand::new(0.95, KpiStatus::AtRisk))
                .with_status_band(StatusBand::new(1.0, KpiStatus::OnTrack)),
        ));
        let facts = facts_from_model(&model);
        let kpi = facts.measures["Revenue"].kpi.as_ref().expect("the KPI is indexed by its base measure");
        assert_eq!(kpi.target, Some(1000.0));
        assert_eq!(
            kpi.bands,
            vec![
                KpiBand::new(0.8, BandStatus::OffTrack),
                KpiBand::new(0.95, BandStatus::AtRisk),
                KpiBand::new(1.0, BandStatus::OnTrack),
            ],
            "the STATUS has to survive the crossing; the threshold alone says nothing"
        );
        assert_eq!(kpi.direction(), Some(Direction::HigherIsBetter));
    }

    #[test]
    fn a_kpi_whose_bands_worsen_upward_crosses_as_lower_is_better() {
        // The engine refuses non-ascending THRESHOLDS, so this is what a churn
        // KPI has to look like: thresholds up, statuses down. Reading thresholds
        // alone reported higherIsBetter for exactly this shape.
        let model = a_small_star_with(Some(
            Kpi::new("Churn KPI", "Revenue", KpiTarget::Constant(0.05))
                .with_status_band(StatusBand::new(0.5, KpiStatus::OnTrack))
                .with_status_band(StatusBand::new(0.8, KpiStatus::AtRisk))
                .with_status_band(StatusBand::new(1.0, KpiStatus::OffTrack)),
        ));
        let facts = facts_from_model(&model);
        let kpi = facts.measures["Revenue"].kpi.as_ref().unwrap();
        assert_eq!(kpi.direction(), Some(Direction::LowerIsBetter));
    }

    #[test]
    fn the_models_own_hierarchies_reach_the_facts_in_level_order() {
        // Validation reads hierarchy membership from here, so a level the model
        // declares is scopable even in a document that has no `hierarchies` of
        // its own.
        let model = a_small_star().with_hierarchies(vec![Hierarchy::new(
            "Calendar",
            "Date",
            vec![HierarchyLevel::new("Month"), HierarchyLevel::new("Date")],
        )]);
        let facts = facts_from_model(&model);
        assert_eq!(
            facts.tables["Date"].hierarchies,
            vec![vec!["Month".to_string(), "Date".to_string()]],
            "coarse-to-fine, in the order the engine declares the levels"
        );
        assert!(facts.tables["Product"].hierarchies.is_empty());
        assert!(facts.in_a_hierarchy(&QualifiedColumn::new("Date", "Month")));
    }

    #[test]
    fn a_measure_valued_kpi_target_is_unknown_rather_than_zero() {
        // The target measure has to EXIST — the model builder validates that —
        // so this points at the only other measure in the fixture. The point of
        // the test is unchanged: a measure-valued target is not a number until a
        // query has run, so nothing here may report one.
        let model = a_small_star_with(Some(Kpi::new(
            "Revenue KPI",
            "Revenue",
            KpiTarget::Measure("Revenue".to_string()),
        )));
        let facts = facts_from_model(&model);
        assert_eq!(facts.measures["Revenue"].kpi.as_ref().unwrap().target, None);
    }

    #[test]
    fn a_percent_format_is_a_percent_and_a_quoted_percent_sign_is_not() {
        assert_eq!(unit_from_format("0.0%"), Some(Unit::Percent));
        // The trap: this format shows a NUMBER with the word-like suffix " %"
        // pinned on. Reading it as a percent scales the sentence by 100.
        assert_eq!(unit_from_format("#,##0\" %\""), Some(Unit::Count));
        assert_eq!(unit_from_format("#,##0\\%"), Some(Unit::Count));
    }

    #[test]
    fn a_currency_format_is_currency_in_both_spellings() {
        assert_eq!(unit_from_format("[$SEK-41d] #,##0"), Some(Unit::Currency));
        assert_eq!(unit_from_format("$#,##0.00"), Some(Unit::Currency));
    }

    #[test]
    fn a_format_that_says_nothing_useful_returns_no_unit_rather_than_guessing() {
        assert_eq!(unit_from_format("0.000"), None);
        assert_eq!(unit_from_format("General"), None);
    }

    // --- the name lexicon ----------------------------------------------------

    #[test]
    fn a_revenue_measure_formatted_as_a_plain_integer_is_currency_and_not_a_count() {
        // THE DEFECT. `#,##0` is what a whole-krona money measure is formatted
        // with, and reading the format alone answered COUNT for a measure named
        // Revenue - visible in the Strategy tab as "Revenue: count".
        assert_eq!(infer_unit("Revenue", Some("#,##0")), Some(Unit::Currency));
        assert_eq!(
            unit_from_format("#,##0"),
            Some(Unit::Count),
            "the format reading itself is unchanged; the NAME is what breaks the tie"
        );
        // ...and a name that says nothing still lets the ambiguous format answer.
        assert_eq!(infer_unit("Widgets", Some("#,##0")), Some(Unit::Count));
    }

    #[test]
    fn an_explicit_format_signal_outranks_the_name() {
        // A person who wrote a `%` meant it. The name may only decide where the
        // format was ambiguous, or it would silently rescale a real percentage.
        assert_eq!(infer_unit("Revenue Share", Some("0.0%")), Some(Unit::Percent));
        assert_eq!(infer_unit("Revenue", Some("0.0%")), Some(Unit::Percent));
        assert_eq!(
            infer_unit("Order Count", Some("[$SEK-41d] #,##0")),
            Some(Unit::Currency)
        );
        // The DECORATIVE percent is not an explicit signal, so the name still
        // answers - and does not turn `#,##0" %"` into a rescaled percentage.
        assert_eq!(infer_unit("Revenue", Some("#,##0\" %\"")), Some(Unit::Currency));
    }

    #[test]
    fn the_name_lexicon_matches_whole_words_in_both_languages() {
        // The substring trap, the same one infer.rs's direction lexicon carries:
        // "Costa" must not read as "cost", and "Shareholder" must not read as
        // "share".
        assert_eq!(infer_unit("Costa Rica Sales", None), Some(Unit::Currency));
        assert_eq!(infer_unit("Shareholder", None), None);
        assert_eq!(infer_unit("Omsättning", None), Some(Unit::Currency));
        assert_eq!(infer_unit("Antal Ordrar", None), Some(Unit::Count));
        assert_eq!(infer_unit("Andel Nordics", None), Some(Unit::Percent));
        // A name with no term at all says nothing, and a measure with neither a
        // name term nor a format is left with no unit rather than a guess.
        assert_eq!(infer_unit("Widgets", None), None);
    }

    #[test]
    fn percent_outranks_currency_and_count_outranks_currency_in_the_name() {
        // "Margin Percent" carries both a money word and a proportion word; the
        // ORDER is what decides, and it is the order that costs least when wrong.
        assert_eq!(infer_unit("Margin Percent", None), Some(Unit::Percent));
        assert_eq!(infer_unit("Margin", None), Some(Unit::Currency));
        assert_eq!(infer_unit("Sales Count", None), Some(Unit::Count));
        assert_eq!(infer_unit("Number of Orders", None), Some(Unit::Count));
        // ...and "headcount" is its own term, because word boundaries mean
        // "count" does not match inside it.
        assert_eq!(infer_unit("Headcount", None), Some(Unit::Count));
    }

    // --- which table is the calendar ----------------------------------------

    /// A warehouse `dim_date`: a surrogate key, one real date, and calendar
    /// parts typed `Decimal(38,10)` the way a star schema imported from a
    /// database actually types them. NOTHING marks it.
    ///
    /// `mark_date_table` is builder-only and no host command sets it, so this —
    /// not the marked star above — is what an ordinary imported model looks like.
    fn an_unmarked_warehouse_calendar() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("DateKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_date",
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Decimal(38, 10)),
                        Column::new("quarter", DataType::Decimal(38, 10)),
                        Column::new("month", DataType::Decimal(38, 10)),
                        Column::new("day", DataType::Decimal(38, 10)),
                        Column::new("week_of_year", DataType::Decimal(38, 10)),
                        Column::new("month_name", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Date",
                "Sales",
                "DateKey",
                "dim_date",
                "date_key",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the unmarked warehouse calendar fixture builds")
    }

    #[test]
    fn an_unmarked_warehouse_date_table_is_inferred_and_stamped_as_a_guess() {
        let facts = facts_from_model(&an_unmarked_warehouse_calendar());
        assert_eq!(facts.date_table.as_deref(), Some("dim_date"));
        assert_eq!(facts.calendar_source, Some(CalendarSource::Inferred));
        // ...and the classification cascades from it: without this the table
        // would be an ordinary Dimension and the role ladder's calendar arm
        // would never fire.
        assert_eq!(facts.tables["dim_date"].kind, Some(TableKind::Calendar));
    }

    #[test]
    fn a_declared_date_table_wins_even_when_another_table_looks_more_like_one() {
        // `Kalender` carries a date and one calendar word; `dim_date` carries a
        // date and six. The heuristic would prefer `dim_date` and it does not
        // get a vote: a mark is the author's own statement.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("DateKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Kalender",
                    vec![
                        Column::new("datum", DataType::Date),
                        Column::new("år", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_date",
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Int32),
                        Column::new("quarter", DataType::Int32),
                        Column::new("month", DataType::Int32),
                        Column::new("day", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Date",
                "Sales",
                "DateKey",
                "dim_date",
                "date_key",
            ))
            .mark_date_table("Kalender")
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the declared-vs-better-looking fixture builds");
        let facts = facts_from_model(&model);
        assert_eq!(facts.date_table.as_deref(), Some("Kalender"));
        assert_eq!(facts.calendar_source, Some(CalendarSource::Declared));
        assert_eq!(facts.tables["dim_date"].kind, Some(TableKind::Dimension));
    }

    #[test]
    fn two_candidate_calendars_infer_neither_rather_than_picking_one() {
        // A role-playing pair: order date and ship date, both shaped exactly
        // like a calendar. WHICH ONE time runs along is a business decision, and
        // answering it from table declaration order would be the confident-wrong
        // this whole layer exists to avoid.
        let mut builder = DataModel::builder().add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("Amount", DataType::Float64),
                    Column::new("OrderDateKey", DataType::Int64),
                    Column::new("ShipDateKey", DataType::Int64),
                ],
            )
            .unwrap(),
        );
        for name in ["dim_order_date", "dim_ship_date"] {
            builder = builder.add_table(
                Table::new(
                    name,
                    vec![
                        Column::new("date_key", DataType::Int64),
                        Column::new("full_date", DataType::Date),
                        Column::new("year", DataType::Int32),
                        Column::new("month", DataType::Int32),
                    ],
                )
                .unwrap(),
            );
        }
        let model = builder
            .add_relationship(Relationship::many_to_one(
                "Sales_Order",
                "Sales",
                "OrderDateKey",
                "dim_order_date",
                "date_key",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Ship",
                "Sales",
                "ShipDateKey",
                "dim_ship_date",
                "date_key",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the role-playing fixture builds");
        let facts = facts_from_model(&model);
        assert_eq!(facts.date_table, None, "ambiguity refuses");
        assert_eq!(facts.calendar_source, None);
        assert_eq!(facts.tables["dim_order_date"].kind, Some(TableKind::Dimension));
    }

    #[test]
    fn a_fact_table_carrying_a_date_and_calendar_names_is_never_the_calendar() {
        // The trap a laxer rule falls into: a wide fact table often carries an
        // order date AND denormalised year/month columns. Filters flow OUT of
        // it, which is what makes it the grain rather than an axis.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("order_date", DataType::Date),
                        Column::new("year", DataType::Int32),
                        Column::new("month", DataType::Int32),
                        Column::new("ProductKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Product",
                    vec![
                        Column::new("ProductKey", DataType::Int64),
                        Column::new("Category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Product",
                "Sales",
                "ProductKey",
                "Product",
                "ProductKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the denormalised fact fixture builds");
        let facts = facts_from_model(&model);
        assert_eq!(facts.date_table, None);
        assert_eq!(facts.tables["Sales"].kind, Some(TableKind::Fact));
    }

    #[test]
    fn a_dimension_with_a_date_but_no_calendar_vocabulary_is_not_the_calendar() {
        // The other half of the conservatism: a customer dimension has a
        // `created_at` and is not a calendar. One calendar-ish column would not
        // be enough either — `MIN_CALENDAR_PART_COLUMNS` is two.
        let model = a_small_star();
        assert_eq!(facts_from_model(&model).date_table.as_deref(), Some("Date"));

        let unmarked = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("Amount", DataType::Float64),
                        Column::new("CustomerKey", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Customer",
                    vec![
                        Column::new("CustomerKey", DataType::Int64),
                        Column::new("Segment", DataType::String),
                        Column::new("BirthYear", DataType::Int32),
                        Column::new("created_at", DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Customer",
                "Sales",
                "CustomerKey",
                "Customer",
                "CustomerKey",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the customer-dimension fixture builds");
        let facts = facts_from_model(&unmarked);
        assert_eq!(
            facts.date_table, None,
            "one year column is an attribute, not a calendar"
        );
    }

    #[test]
    fn a_measures_name_reaches_the_facts_the_resolver_reads() {
        // End to end: the lexicon is only worth anything if it survives the
        // crossing into `ModelFacts`, which is what the whole strategy layer
        // resolves against.
        let model = a_small_star();
        let facts = facts_from_model(&model);
        assert_eq!(
            facts.measures["Revenue"].unit,
            Some(Unit::Currency),
            "the fixture measure carries no format string at all, so the name is \
             the only thing that can answer"
        );
    }
}
