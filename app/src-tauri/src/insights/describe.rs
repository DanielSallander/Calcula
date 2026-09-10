//! FILENAME: app/src-tauri/src/insights/describe.rs
// PURPOSE: The strategy document, summarised for a MODEL to read: one line per
//          measure saying which way is good, what counts as material, what to
//          group by and what never to group by.
// CONTEXT: Until 2026-09-10 the only strategy-aware door a language model had
//          was `analyze_model`. `describe_bi_model` - the tool every chat and
//          MCP client calls BEFORE it writes a query - printed tables, measures,
//          KPIs and relationships and not one strategy attribute, so a model
//          composing a `run_bi_query` had no idea which measures mattered,
//          which way was good, or which dimensions the business slices by. It
//          grouped Revenue by invoice id as readily as by region. This block is
//          what tells it.
//
//          STRUCTURED ATTRIBUTES ONLY. `MeasureStrategy.context` is prose, and
//          section 2 of the design doc says prose reaches WORDING and never
//          selection. A chat model deciding which query to run is selection, so
//          the `context` string is never printed here, and a test pins that
//          with the fixture's own sentence. Its reader is the narrator, M6.
//
//          THE ORDER IS THE RUN'S ORDER. `choose_measures` decides which
//          measures an analysis reports first - declared priority, then the
//          measures carrying a KPI, then the rest by name - and this block lists
//          them the same way, so a model reading both sees one ranking rather
//          than two that disagree.
//
//          CAPPED, AND THE CAP SAYS SO. A small local model holds a few dozen
//          names in its head; a wide warehouse model has hundreds of measures.
//          Past `MAX_STRATEGY_LINES` the block says how many it left out rather
//          than trailing off, because a list that reads as complete when it is
//          not is exactly the quiet lie the notes elsewhere exist to prevent.

use std::collections::BTreeMap;

use bi_engine::DataModel;
use serde::{Deserialize, Serialize};

use super::model::choose_measures;
use super::model_commands::strategy_doc;
use super::strategy::facts::facts_with_authored_kinds;
use super::strategy::resolve::{resolve, CalendarSource, ModelFacts, ResolvedMeasure, ScopePoint};
use super::strategy::types::{
    Additivity, Attribute, Cadence, Direction, Materiality, Role, StrategyDoc, Target, Unit,
};

// ---------------------------------------------------------------------------
// The structured form, for the design-query assistant
// ---------------------------------------------------------------------------

/// What the strategy says about one measure that decides which names a model
/// is shown. Mirrors `DesignMeasureHints` in
/// `app/src/api/designQueryAssist/types.ts`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignMeasureHints {
    /// The resolved direction's wire word, when one resolved. Informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    /// `Table[Column]` spellings, verbatim from the document.
    pub analysis_dimensions: Vec<String>,
    pub never_slice_by: Vec<String>,
}

/// The strategy document reduced to the structured attributes that decide
/// WHICH names a model composing a design query is shown and how they RANK.
/// Prose never appears here. Mirrors `DesignStrategySummary` in
/// `app/src/api/designQueryAssist/types.ts`; a test there parses this struct.
///
/// Travels on `BiPivotModelInfo` for a connection, so the report, chart and
/// pivot editors get it with the model they already fetch, and the strategy
/// is a consumer of exactly one more read.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignStrategySummary {
    /// Measures in the run's own order: declared priority, KPIs, then the rest.
    pub measure_order: Vec<String>,
    pub measures: BTreeMap<String, DesignMeasureHints>,
    /// `Table[Column]` -> role wire word.
    pub column_roles: BTreeMap<String, String>,
    /// Table -> the column a reader recognises a row by.
    pub label_columns: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_axis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_table: Option<String>,
}

/// The wire spelling of a camelCase-serialised unit enum, for a summary field
/// that carries the word rather than the type.
fn wire_word<T: Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
}

/// The structured summary for a model, or `None` when it carries no strategy
/// document. Same reading as `strategy_summary`: the run's loader, the run's
/// facts, the run's measure order.
pub fn strategy_for_design(model: &DataModel) -> Option<DesignStrategySummary> {
    let mut notes: Vec<String> = Vec::new();
    let doc = strategy_doc(model, &mut notes);
    if says_nothing(&doc) {
        return None;
    }
    let (facts, _authored) = facts_with_authored_kinds(model, &doc);
    let ordered = ordered_measures(&doc, &facts);

    let mut measures: BTreeMap<String, DesignMeasureHints> = BTreeMap::new();
    for name in &ordered {
        let resolved = resolve(&facts, &doc, name, &ScopePoint::default());
        let hints = DesignMeasureHints {
            direction: resolved.direction.as_ref().and_then(|d| wire_word(&d.value)),
            analysis_dimensions: resolved.analysis_dimensions.iter().map(|c| c.to_string()).collect(),
            never_slice_by: resolved.never_slice_by.iter().map(|c| c.to_string()).collect(),
        };
        // Only measures the document says something about carry an entry;
        // an empty entry for every measure would be noise a reader has to
        // skip and a wire payload nobody asked for.
        if hints.direction.is_some()
            || !hints.analysis_dimensions.is_empty()
            || !hints.never_slice_by.is_empty()
        {
            measures.insert(name.clone(), hints);
        }
    }

    let mut column_roles: BTreeMap<String, String> = BTreeMap::new();
    let mut label_columns: BTreeMap<String, String> = BTreeMap::new();
    for (table, strategy) in &doc.tables {
        for (column, c) in &strategy.columns {
            if let Some(role) = wire_word(&c.role) {
                column_roles.insert(format!("{table}[{column}]"), role);
            }
        }
        if let Some(label) = &strategy.label_column {
            label_columns.insert(table.clone(), label.clone());
        }
    }

    Some(DesignStrategySummary {
        measure_order: ordered,
        measures,
        column_roles,
        label_columns,
        time_axis: doc.model.default_time_axis.as_ref().map(|c| c.to_string()),
        calendar_table: facts.date_table.clone(),
    })
}

/// Measure lines the block prints before it says how many more there are.
pub const MAX_STRATEGY_LINES: usize = 40;

/// Table lines the block prints before it says how many more there are.
pub const MAX_TABLE_LINES: usize = 20;

/// The heading the block opens with. Named so a caller can find the block in
/// the text it was appended to.
pub const STRATEGY_HEADING: &str = "## Strategy (what the business says about these measures)";

/// The strategy block for a model, or `None` when the model carries no strategy
/// document at all.
///
/// `None` rather than an empty heading: a model nobody has annotated gets
/// nothing appended, so a reader is never told there is a strategy and then
/// shown a blank one. An UNREADABLE document is different and is reported as a
/// note inside the block, the way the run itself reports it.
pub fn strategy_summary(model: &DataModel) -> Option<String> {
    let mut notes: Vec<String> = Vec::new();
    let doc = strategy_doc(model, &mut notes);
    if notes.is_empty() && says_nothing(&doc) {
        return None;
    }
    let (facts, _authored) = facts_with_authored_kinds(model, &doc);
    let ordered = ordered_measures(&doc, &facts);
    Some(render_block(&doc, &facts, &ordered, &notes))
}

/// Whether the document states anything a model could act on.
fn says_nothing(doc: &StrategyDoc) -> bool {
    doc.measures.is_empty()
        && doc.tables.is_empty()
        && doc.rules.is_empty()
        && doc.model.priority.is_empty()
        && doc.model.default_time_axis.is_none()
}

/// Every measure the model declares, in the run's order.
///
/// `choose_measures` truncates to the run's own budget; the measures it cut are
/// appended by name so the description is complete up to ITS cap, which is a
/// different number for a different reason.
fn ordered_measures(doc: &StrategyDoc, facts: &ModelFacts) -> Vec<String> {
    let mut ordered = choose_measures(doc, facts, &[]);
    for name in facts.measures.keys() {
        if !ordered.iter().any(|m| m == name) {
            ordered.push(name.clone());
        }
    }
    ordered
}

/// The block itself, over an already-decided measure order.
///
/// Pure, so the cap and the wording are tested without a model: a caller hands
/// in forty-five names and reads back "and 5 more".
pub fn render_block(
    doc: &StrategyDoc,
    facts: &ModelFacts,
    ordered: &[String],
    notes: &[String],
) -> String {
    let mut out = String::new();
    out.push_str(STRATEGY_HEADING);
    out.push('\n');
    out.push_str(
        "Direction is which way is good. 'material from' is the smallest movement worth \
         reporting. 'group by' names the columns the business breaks this measure down by; \
         'never by' names columns that must not appear in a breakdown of it. Prose the author \
         wrote is not included here.\n",
    );
    for note in notes {
        out.push_str(&format!("Note: {note}\n"));
    }

    for name in ordered.iter().take(MAX_STRATEGY_LINES) {
        let resolved = resolve(facts, doc, name, &ScopePoint::default());
        out.push_str(&format!("- {}\n", measure_line(&resolved)));
    }
    if ordered.len() > MAX_STRATEGY_LINES {
        out.push_str(&format!(
            "- and {} more measure(s) not listed; name one to analyze_model to read its settings.\n",
            ordered.len() - MAX_STRATEGY_LINES
        ));
    }

    let tables = table_lines(doc);
    if !tables.is_empty() {
        out.push_str("Tables:\n");
        for line in tables.iter().take(MAX_TABLE_LINES) {
            out.push_str(line);
            out.push('\n');
        }
        if tables.len() > MAX_TABLE_LINES {
            out.push_str(&format!(
                "- and {} more table(s) not listed.\n",
                tables.len() - MAX_TABLE_LINES
            ));
        }
    }

    if !doc.model.priority.is_empty() {
        out.push_str(&format!("Priority order: {}\n", doc.model.priority.join(", ")));
    }
    if let Some(axis) = &doc.model.default_time_axis {
        out.push_str(&format!("Time axis: {axis}\n"));
    }
    if let Some(table) = &facts.date_table {
        let how = match facts.calendar_source {
            Some(CalendarSource::Declared) => "marked in the model",
            Some(CalendarSource::Authored) => "named in the strategy document",
            Some(CalendarSource::Inferred) | None => "guessed from its shape",
        };
        out.push_str(&format!("Calendar table: {table} ({how})\n"));
    }
    out
}

/// One measure, attribute by attribute, absent ones omitted.
fn measure_line(r: &ResolvedMeasure) -> String {
    let mut parts: Vec<String> = Vec::new();

    match &r.direction {
        Some(d) => parts.push(direction_words(d.value).to_string()),
        None if r.suppression_of(Attribute::Direction).is_some() => {
            parts.push("direction withheld here because rules disagree".to_string());
        }
        None => parts.push("direction not stated".to_string()),
    }
    if let Some(u) = &r.unit {
        parts.push(format!("unit {}", unit_word(u.value)));
    }
    if let Some(t) = &r.target {
        parts.push(target_words(&t.value));
    }
    if let Some(m) = &r.materiality {
        parts.push(materiality_words(&m.value));
    }
    if let Some(a) = &r.aggregation {
        if a.value.default != Additivity::Additive {
            parts.push(format!("aggregation {}", additivity_word(a.value.default)));
        }
        for (dimension, additivity) in &a.value.by_dimension {
            parts.push(format!("over {dimension}: {}", additivity_word(*additivity)));
        }
    }
    if let Some(c) = &r.cadence {
        parts.push(format!("reported {}", cadence_word(c.value)));
    }
    if let Some(p) = &r.priority {
        parts.push(format!("priority {}", p.value));
    }
    if !r.analysis_dimensions.is_empty() {
        parts.push(format!("group by {}", join_columns(&r.analysis_dimensions)));
    }
    if !r.never_slice_by.is_empty() {
        parts.push(format!("never by {}", join_columns(&r.never_slice_by)));
    }
    if !r.suppressed_kinds.is_empty() {
        let kinds: Vec<String> = r.suppressed_kinds.iter().map(|k| k.to_string()).collect();
        parts.push(format!("do not report {}", kinds.join(", ")));
    }

    format!("{}: {}", r.measure, parts.join("; "))
}

/// The tables the document says something about: a kind, a label column, or
/// columns in the `analysis` role.
fn table_lines(doc: &StrategyDoc) -> Vec<String> {
    doc.tables
        .iter()
        .filter_map(|(name, table)| {
            let mut parts: Vec<String> = Vec::new();
            if let Some(kind) = table.kind {
                parts.push(kind.label().to_string());
            }
            let analysis: Vec<&str> = table
                .columns
                .iter()
                .filter(|(_, c)| c.role == Role::Analysis)
                .map(|(column, _)| column.as_str())
                .collect();
            if !analysis.is_empty() {
                parts.push(format!("group by {}", analysis.join(", ")));
            }
            if let Some(label) = &table.label_column {
                parts.push(format!("label column {label}"));
            }
            if parts.is_empty() {
                None
            } else {
                Some(format!("- {name}: {}", parts.join("; ")))
            }
        })
        .collect()
}

fn join_columns(columns: &[super::strategy::QualifiedColumn]) -> String {
    columns.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(", ")
}

fn direction_words(d: Direction) -> &'static str {
    match d {
        Direction::HigherIsBetter => "higher is better",
        Direction::LowerIsBetter => "lower is better",
        Direction::TargetBand => "good inside the target band, bad on either side",
        Direction::Neutral => "neutral, a move is neither good nor bad",
    }
}

fn unit_word(u: Unit) -> &'static str {
    match u {
        Unit::Currency => "currency",
        Unit::Percent => "percent",
        Unit::Ratio => "ratio",
        Unit::Count => "count",
        Unit::Duration => "duration",
        Unit::Other => "other",
    }
}

fn additivity_word(a: Additivity) -> &'static str {
    match a {
        Additivity::Additive => "additive",
        Additivity::NonAdditive => "non-additive",
        Additivity::LastValue => "last value",
        Additivity::FirstValue => "first value",
        Additivity::Average => "average",
        Additivity::Max => "max",
        Additivity::Min => "min",
    }
}

fn cadence_word(c: Cadence) -> &'static str {
    match c {
        Cadence::Daily => "daily",
        Cadence::Weekly => "weekly",
        Cadence::Monthly => "monthly",
        Cadence::Quarterly => "quarterly",
        Cadence::Yearly => "yearly",
    }
}

fn target_words(t: &Target) -> String {
    match t {
        Target::Literal { value } => format!("target {}", num(*value)),
        Target::Measure { r#ref } => format!("target is the measure '{ref}'"),
        Target::Band { .. } => match t.as_band() {
            Some(bounds) => format!("target band {}", bounds.label()),
            None => "target band".to_string(),
        },
        Target::Kpi => "target from the model's KPI".to_string(),
    }
}

fn materiality_words(m: &Materiality) -> String {
    match m {
        Materiality::Absolute { value } => format!("material from {} (absolute)", num(*value)),
        Materiality::Relative { value } => {
            format!("material from {}% (relative)", num(value * 100.0))
        }
    }
}

/// A number the way a model reads it best: no trailing `.0`, no locale.
///
/// The block is for a model, not a person, and a locale-formatted "1 500 000"
/// is a string a small model splits into three numbers. The reader-facing
/// surfaces format through the locale as they always have.
fn num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::insights::strategy::types::MeasureStrategy;

    fn repo_file(relative: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(relative)
    }

    fn read_json(relative: &str) -> serde_json::Value {
        let path = repo_file(relative);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()))
    }

    /// The star-schema fixture, with no strategy document attached.
    fn star_model() -> DataModel {
        let bundle = read_json("tests/fixtures/model/sales_star.json");
        serde_json::from_value(bundle["model"].clone())
            .expect("the fixture's `model` deserializes as a DataModel")
    }

    /// The same model carrying `doc` under the reserved key, the way the
    /// Strategy tab stores it.
    fn with_strategy(model: &DataModel, doc: serde_json::Value) -> DataModel {
        let mut data = model.extension_data().clone();
        data.insert(crate::bi::model_editor::STRATEGY_EXTENSION_KEY.to_string(), doc);
        model.with_extension_data(data)
    }

    fn star_with_fixture_strategy() -> DataModel {
        with_strategy(&star_model(), read_json("tests/fixtures/model/sales_star_strategy.json"))
    }

    #[test]
    fn a_model_without_a_strategy_document_gets_no_block() {
        // The common case: nobody has annotated this model. Appending an empty
        // heading would tell a reader there is a strategy and then show none.
        assert_eq!(strategy_summary(&star_model()), None);
    }

    #[test]
    fn the_block_names_direction_materiality_and_the_slicing_rules_and_never_the_prose() {
        let out = strategy_summary(&star_with_fixture_strategy()).expect("the fixture has a document");
        assert!(out.starts_with(STRATEGY_HEADING), "{out}");
        assert!(out.contains("- Revenue: higher is better"), "{out}");
        assert!(out.contains("material from 15000 (absolute)"), "{out}");
        assert!(out.contains("target 1500000"), "{out}");
        assert!(out.contains("group by Product[Category], Customer[Segment], Geography[Region]"), "{out}");
        assert!(out.contains("never by Product[Name]"), "{out}");
        // Cost is `lowerIsBetter` in its own entry, and a fixture rule flips it
        // for some members - so at company scope Rule 4 withholds it, exactly as
        // the run does. A model told "lower is better" here would call a rise
        // in a region where the rule applies bad when the business says good.
        assert!(out.contains("- Cost: direction withheld here because rules disagree"), "{out}");
        assert!(out.contains("- Customers: higher is better"), "{out}");
        assert!(out.contains("target band [90000, 140000]"), "{out}");
        assert!(out.contains("over Date: last value"), "{out}");
        assert!(out.contains("Priority order: Revenue, MarginPct, Margin, Cost"), "{out}");

        // THE PROSE STAYS OUT. Both fixture sentences are checked, so a future
        // "include the first context" shortcut cannot pass by omitting one.
        assert!(!out.contains("Gross amount, before freight"), "context prose reached the block:\n{out}");
        assert!(!out.contains("Cost of goods sold"), "context prose reached the block:\n{out}");
    }

    #[test]
    fn the_measures_are_listed_in_the_runs_own_order() {
        let out = strategy_summary(&star_with_fixture_strategy()).unwrap();
        let at = |needle: &str| out.find(needle).unwrap_or_else(|| panic!("{needle} missing:\n{out}"));
        // The declared priority list is Revenue, MarginPct, Margin, Cost, and
        // `choose_measures` honours it before anything else.
        assert!(at("- Revenue:") < at("- MarginPct:"), "{out}");
        assert!(at("- MarginPct:") < at("- Margin:"), "{out}");
        assert!(at("- Margin:") < at("- Cost:"), "{out}");
    }

    #[test]
    fn the_calendar_and_the_time_axis_are_stated() {
        let out = strategy_summary(&star_with_fixture_strategy()).unwrap();
        assert!(out.contains("Time axis: Date[Date]"), "{out}");
        assert!(out.contains("Calendar table: Date ("), "{out}");
    }

    #[test]
    fn past_the_cap_the_block_says_how_many_it_left_out() {
        // Pure over a hand-built order, so the cap is tested without building a
        // model with forty-five measures.
        let doc = StrategyDoc::default();
        let facts = ModelFacts::default();
        let ordered: Vec<String> = (0..MAX_STRATEGY_LINES + 5).map(|i| format!("M{i}")).collect();
        let out = render_block(&doc, &facts, &ordered, &[]);
        assert!(out.contains(&format!("- M{}:", MAX_STRATEGY_LINES - 1)), "{out}");
        assert!(!out.contains(&format!("- M{}:", MAX_STRATEGY_LINES)), "{out}");
        assert!(out.contains("- and 5 more measure(s) not listed"), "{out}");
    }

    #[test]
    fn under_the_cap_nothing_claims_to_be_left_out() {
        let doc = StrategyDoc::default();
        let facts = ModelFacts::default();
        let ordered: Vec<String> = (0..3).map(|i| format!("M{i}")).collect();
        let out = render_block(&doc, &facts, &ordered, &[]);
        assert!(!out.contains("more measure(s)"), "{out}");
    }

    #[test]
    fn a_document_this_build_cannot_read_is_reported_inside_the_block() {
        // Version 99 parses and is refused, exactly as the run refuses it; the
        // block must carry that note rather than silently print nothing.
        let model = with_strategy(&star_model(), serde_json::json!({ "version": 99 }));
        let out = strategy_summary(&model).expect("an unreadable document is worth a note");
        assert!(out.contains("Note:"), "{out}");
        assert!(out.contains("was not applied"), "{out}");
    }

    #[test]
    fn a_measure_entry_with_only_a_direction_prints_only_what_it_states() {
        let mut doc = StrategyDoc::default();
        doc.measures.insert(
            "Churn".to_string(),
            MeasureStrategy { direction: Some(Direction::LowerIsBetter), ..MeasureStrategy::default() },
        );
        let facts = ModelFacts::default();
        let out = render_block(&doc, &facts, &["Churn".to_string()], &[]);
        // The MEASURE line, not the whole block: the vocabulary line above it
        // legitimately names every attribute it explains.
        let line = out
            .lines()
            .find(|l| l.starts_with("- Churn:"))
            .unwrap_or_else(|| panic!("no Churn line:\n{out}"));
        assert_eq!(line, "- Churn: lower is better");
        assert!(!out.contains("Priority order"), "{out}");
        assert!(!out.contains("Tables:"), "{out}");
    }

    #[test]
    fn the_structured_summary_carries_the_order_the_hints_the_roles_and_the_calendar() {
        let s = strategy_for_design(&star_with_fixture_strategy()).expect("the fixture has a document");
        assert_eq!(&s.measure_order[..4], &["Revenue", "MarginPct", "Margin", "Cost"]);
        let revenue = s.measures.get("Revenue").expect("Revenue has an entry");
        assert_eq!(revenue.direction.as_deref(), Some("higherIsBetter"));
        assert_eq!(
            revenue.analysis_dimensions,
            vec!["Product[Category]", "Customer[Segment]", "Geography[Region]"]
        );
        assert_eq!(revenue.never_slice_by, vec!["Product[Name]"]);
        assert_eq!(s.column_roles.get("Product[Category]").map(String::as_str), Some("analysis"));
        assert_eq!(s.label_columns.get("Product").map(String::as_str), Some("Name"));
        assert_eq!(s.time_axis.as_deref(), Some("Date[Date]"));
        assert_eq!(s.calendar_table.as_deref(), Some("Date"));
        // A withheld direction is absent, not invented: Cost's rules disagree
        // at company scope, exactly as the prose block reports it.
        assert_eq!(s.measures.get("Cost").and_then(|h| h.direction.clone()), None);
    }

    #[test]
    fn the_structured_summary_is_absent_for_a_model_without_a_document() {
        assert_eq!(strategy_for_design(&star_model()), None);
    }

    #[test]
    fn the_structured_summary_serialises_camel_case_with_absent_options_omitted() {
        let s = DesignStrategySummary {
            measure_order: vec!["A".into()],
            ..DesignStrategySummary::default()
        };
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("measureOrder").is_some(), "{json}");
        assert!(json.get("columnRoles").is_some(), "{json}");
        assert!(json.get("timeAxis").is_none(), "an absent option is omitted: {json}");
        assert!(json.get("measure_order").is_none(), "no snake_case on the wire: {json}");
    }

    #[test]
    fn numbers_read_as_a_model_reads_them() {
        assert_eq!(num(1500000.0), "1500000");
        assert_eq!(num(2.0), "2");
        assert_eq!(num(0.375), "0.375");
        assert_eq!(materiality_words(&Materiality::Relative { value: 0.015 }), "material from 1.5% (relative)");
    }
}
