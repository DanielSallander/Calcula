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
//          by a format string, which table is the calendar, which columns exist,
//          which hierarchies the model declares.
//          Extracting one of them wrongly does not produce an error; it
//          produces a confidently wrong favourability, which is why each
//          derivation below states what it assumes.

use std::collections::{BTreeMap, BTreeSet};

use bi_engine::{Cardinality, DataModel, KpiStatus, KpiTarget};

use super::resolve::{BandStatus, KpiBand, KpiFacts, MeasureFacts, ModelFacts, TableFacts};
use super::types::{QualifiedColumn, TableKind, Unit};

/// Read a model into the facts the strategy layer resolves against.
pub fn facts_from_model(model: &DataModel) -> ModelFacts {
    let mut facts = ModelFacts {
        date_table: model.date_table().map(|t| t.to_string()),
        ..ModelFacts::default()
    };

    // --- relationships ------------------------------------------------------
    // Only ACTIVE relationships. An inactive one exists for a `USERELATIONSHIP`
    // that the insights planner never issues, so treating it as reachable would
    // offer the user a breakdown the engine would refuse to compute.
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
                unit: measure.format_string().and_then(unit_from_format),
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

/// The unit a number-format string implies.
///
/// Deliberately conservative. `Other` means "we could not tell", and the
/// downstream effect of `Other` is that a sentence says the bare number — which
/// is never wrong, only less helpful. Guessing `Percent` at a format that is not
/// one produces a sentence that is off by a factor of a hundred.
fn unit_from_format(format: &str) -> Option<Unit> {
    // A literal escaped percent (`\%`) or one inside quotes is decoration, not a
    // scale factor. Strip both before looking, or `#,##0" %"` reads as percent
    // and the value is reported a hundred times too small.
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

    if significant.contains('%') {
        return Some(Unit::Percent);
    }
    // `[$SEK-41d]` and friends: the engine carries the currency inside a bracket
    // section, and a bare currency symbol is the older spelling.
    let lower = significant.to_ascii_lowercase();
    if lower.contains("[$") || significant.contains('$') || significant.contains('€') || significant.contains('£') || lower.contains("kr") {
        return Some(Unit::Currency);
    }
    // An integer format with no decimal separator is a count often enough to be
    // worth saying, and being wrong costs only a rounding style in a sentence.
    if !significant.is_empty()
        && significant.chars().all(|c| matches!(c, '#' | '0' | ',' | ' ' | '_' | '-' | '(' | ')'))
        && !significant.contains('.')
    {
        return Some(Unit::Count);
    }
    None
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
}
