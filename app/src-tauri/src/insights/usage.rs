//! FILENAME: app/src-tauri/src/insights/usage.rs
// PURPOSE: Mine the OPEN workbook for how its model is actually used - which
//          measure is broken down by which column, how often, and in objects
//          somebody bothered to save - so inference can rank a draft by what
//          this team looks at rather than by alphabetical order.
// CONTEXT: THIS READS NOTHING THAT IS NOT ALREADY IN THE FILE THE USER HAS
//          OPEN. BI pivot definitions, ribbon filters, slicers and saved pivot
//          layouts are all persisted workbook state; folding them into counts
//          adds no new information and leaves the machine. That is why it needs
//          no consent gate and does not appear in the audit trail - there is no
//          reach to audit. Sending these aggregates anywhere is a different
//          feature with its own manifest declaration, and it is not this one.
//
//          SAVED OUTWEIGHS TRANSIENT. A pivot somebody built this morning is
//          evidence; a layout somebody NAMED and stored is a decision. So a
//          pairing from a saved layout counts double (`SAVED_WEIGHT`), and the
//          "highly used" threshold is set so that one saved layout, or two
//          separate live objects, clears it while a single ad-hoc pivot does
//          not. One pivot is an experiment; the second occurrence is a habit.
//
//          THE DOTTED-TABLE TRAP. Pivot field keys are `Table.Column` strings
//          and a TABLE NAME CAN CONTAIN A DOT - `BI.dim_customer.fullname` is
//          table `BI.dim_customer`, column `fullname`. Splitting on the first
//          dot yields table `BI`, which exists in no model, so every pairing on
//          such a source is silently dropped and the usage index reports that
//          nobody uses the warehouse. Every split here goes through
//          `split_bi_field_key`, which resolves against the model's own table
//          list, longest match wins.

use std::collections::{BTreeMap, HashMap};

use bi_engine::{DataModel, DateRole};
use serde::{Deserialize, Serialize};

use crate::insights::strategy::{Cadence, Finding, QualifiedColumn, Severity, StrategyDoc};

/// How much more a pairing from a deliberately saved object weighs.
pub const SAVED_WEIGHT: u32 = 2;

/// The score at which a pairing is "highly used" and its absence from a
/// measure's `analysisDimensions` is worth telling somebody about.
///
/// Two: one saved layout, or two independent live objects. Set to one, every
/// throwaway pivot would produce a suggestion and the suggestions would be
/// ignored as a class.
pub const HIGH_USE_SCORE: u32 = 2;

/// Which kind of workbook object supplied a pairing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageObjectKind {
    BiPivot,
    RibbonFilter,
    Slicer,
    SavedLayout,
}

/// One measure x column pairing, and how much evidence there is for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingCount {
    pub measure: String,
    pub column: QualifiedColumn,
    pub object_kind: UsageObjectKind,
    /// How many objects of this kind pair them.
    pub count: u32,
    /// True when the objects are named, stored artefacts rather than live state.
    pub saved: bool,
}

/// One object's worth of evidence, reduced to the only two things that matter.
///
/// Collection and folding are split here on purpose: every source below turns
/// into this shape first, so the counting rules are written once and can be
/// tested with struct literals instead of a live `PivotCache`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObservedObject {
    pub kind: UsageObjectKind,
    pub saved: bool,
    /// Measures this object reports.
    pub measures: Vec<String>,
    /// Columns this object breaks them down by, or filters them with.
    pub columns: Vec<QualifiedColumn>,
}

impl Default for UsageObjectKind {
    fn default() -> Self {
        UsageObjectKind::BiPivot
    }
}

/// What the workbook says about how its own model is used.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageIndex {
    /// Every pairing, sorted deterministically so a redraft diffs cleanly.
    pub pairings: Vec<PairingCount>,
    /// The FINEST date grain each measure is actually reported at.
    pub cadence: BTreeMap<String, Cadence>,
}

impl UsageIndex {
    /// Fold observed objects into counts.
    ///
    /// `model` is consulted only to recognise a date column and its declared
    /// grain; the pairings themselves are already resolved by this point.
    pub fn build(objects: &[ObservedObject], model: &DataModel) -> UsageIndex {
        let mut counts: BTreeMap<(String, QualifiedColumn, UsageObjectKind, bool), u32> =
            BTreeMap::new();
        let mut cadence: BTreeMap<String, Cadence> = BTreeMap::new();

        for object in objects {
            for measure in &object.measures {
                for column in &object.columns {
                    *counts
                        .entry((
                            measure.clone(),
                            column.clone(),
                            object.kind,
                            object.saved,
                        ))
                        .or_insert(0) += 1;

                    // The finest grain WINS: a workbook that reports Revenue
                    // both yearly and daily is a workbook where a daily
                    // statement is meaningful, and a monthly default would
                    // withhold every fact between the two.
                    if let Some(grain) = date_grain_of(model, column) {
                        let candidate = cadence_of(grain);
                        cadence
                            .entry(measure.clone())
                            .and_modify(|c| {
                                if cadence_rank(candidate) > cadence_rank(*c) {
                                    *c = candidate;
                                }
                            })
                            .or_insert(candidate);
                    }
                }
            }
        }

        UsageIndex {
            pairings: counts
                .into_iter()
                .map(
                    |((measure, column, object_kind, saved), count)| PairingCount {
                        measure,
                        column,
                        object_kind,
                        count,
                        saved,
                    },
                )
                .collect(),
            cadence,
        }
    }

    /// How much evidence there is that this measure is looked at by this column.
    pub fn score(&self, measure: &str, column: &QualifiedColumn) -> u32 {
        self.pairings
            .iter()
            .filter(|p| p.measure == measure && &p.column == column)
            .map(|p| p.count * if p.saved { SAVED_WEIGHT } else { 1 })
            .sum()
    }

    /// How much this workbook looks at this measure at all.
    pub fn measure_score(&self, measure: &str) -> u32 {
        self.pairings
            .iter()
            .filter(|p| p.measure == measure)
            .map(|p| p.count * if p.saved { SAVED_WEIGHT } else { 1 })
            .sum()
    }

    /// Measures this workbook actually reports, most looked at first.
    ///
    /// Only measures with EVIDENCE appear, and that is the whole contract: this
    /// function reports what the workbook looks at and invents nothing. A list
    /// that restated every measure in alphabetical order would be a ranking
    /// nobody asked for, silently breaking ties in the insights engine.
    ///
    /// An EMPTY answer is therefore meaningful rather than a gap, and `infer`
    /// treats it that way: it seeds `model.priority` itself when this is empty
    /// (`seed_priority`), from KPI membership and the model's declaration
    /// order — never alphabetical, for exactly the reason above. Evidence still
    /// wins outright whenever there is any.
    pub fn ranked_measures(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .pairings
            .iter()
            .map(|p| p.measure.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        names.sort_by(|a, b| {
            self.measure_score(b)
                .cmp(&self.measure_score(a))
                .then_with(|| a.cmp(b))
        });
        names
    }

    /// The finest grain this workbook reports the measure at.
    pub fn cadence_for(&self, measure: &str) -> Option<Cadence> {
        self.cadence.get(measure).copied()
    }
}

/// Coarse-to-fine, so "finest wins" is a comparison rather than a table of
/// special cases.
fn cadence_rank(c: Cadence) -> u8 {
    match c {
        Cadence::Yearly => 0,
        Cadence::Quarterly => 1,
        Cadence::Monthly => 2,
        Cadence::Weekly => 3,
        Cadence::Daily => 4,
    }
}

fn cadence_of(role: DateRole) -> Cadence {
    match role {
        DateRole::Year => Cadence::Yearly,
        DateRole::Quarter => Cadence::Quarterly,
        DateRole::Month => Cadence::Monthly,
        DateRole::Week => Cadence::Weekly,
        DateRole::Day | DateRole::DateKey => Cadence::Daily,
    }
}

/// The date grain a column reports, from what the MODEL declares.
///
/// The declared `date_role` is the only source used. Guessing a grain from a
/// column name would put "Yearly" on a `Customer[Year Joined]` column that is
/// not a time axis at all, and the cost of that is a cadence - and therefore a
/// materiality window - applied to the wrong measure.
fn date_grain_of(model: &DataModel, column: &QualifiedColumn) -> Option<DateRole> {
    model
        .table(&column.table)
        .ok()?
        .column(&column.column)
        .ok()?
        .date_role()
}

// ---------------------------------------------------------------------------
// Turning workbook objects into observations
// ---------------------------------------------------------------------------

/// Resolve a pivot field key against the model, or `None` when it names
/// something that is not a model column (a calculation group, the synthetic
/// "Total" row field, a stale reference to a renamed table).
fn resolve_field_key(name: &str, model: &DataModel) -> Option<QualifiedColumn> {
    // NEVER `name.split_once('.')`. A table can contain a dot — `BI.dim_customer`
    // is an ordinary name for a table imported from a schema — and splitting on
    // the first one reads that key as table "BI", which is in no model. The
    // pairing then vanishes with no error anywhere, and the only symptom is an
    // analysis dimension that mysteriously never gets ranked.
    //
    // The rule (longest model table name that prefixes the key wins) is NOT
    // re-implemented here. `split_bi_field_key` is the repo's one splitter, it
    // has its own tests, and every other caller — the pivot refresh, the slicer
    // commands, the .calp publisher — already goes through it. A second copy
    // would drift on the owner's first change and this one would go on quietly
    // dropping pairings.
    let table_names: Vec<&str> = model.tables().iter().map(|t| t.name()).collect();
    let (table, column) =
        crate::pivot::commands::split_bi_field_key(name, table_names.iter().copied());
    // The splitter falls back to a first-dot split for a key naming no known
    // table, so the result still has to be CHECKED against the model: an
    // unresolvable key is dropped rather than counted against a table that does
    // not exist.
    model.table(&table).ok()?.column(&column).ok()?;
    Some(QualifiedColumn::new(table, column))
}

/// Strip the `[...]` display wrapper a BI value field wears, then keep the name
/// only if the model really has such a measure.
fn resolve_measure_name(raw: &str, model: &DataModel) -> Option<String> {
    let bare = raw.trim_start_matches('[').trim_end_matches(']').trim();
    model.measure(bare).ok().map(|m| m.name().to_string())
}

/// One BI pivot's evidence: its measures against every column it groups or
/// filters by.
pub fn observe_bi_pivot(
    definition: &pivot_engine::PivotDefinition,
    model: &DataModel,
) -> ObservedObject {
    let mut columns: Vec<QualifiedColumn> = Vec::new();
    for field in definition
        .row_fields
        .iter()
        .chain(definition.column_fields.iter())
    {
        if let Some(qc) = resolve_field_key(&field.name, model) {
            columns.push(qc);
        }
    }
    for filter in &definition.filter_fields {
        if let Some(qc) = resolve_field_key(&filter.field.name, model) {
            columns.push(qc);
        }
    }
    // Engine-routed (pinned) filters already carry table and column separately,
    // so no split is needed - and they are genuine usage: a pinned filter is a
    // deliberate, surviving constraint on the measure.
    //
    // These are ALL pins today. If level-1 routing is ever enabled (BUG-0108 in
    // docs/design/open-items.md), this list starts mixing levels - and both
    // should still count, because a routed level-1 selection is a constraint
    // the user applied by clicking. Gating on `level > 1` then would
    // UNDER-count exactly the pivots that do the most filtering.
    for filter in &definition.engine_filters {
        let qc = QualifiedColumn::new(&filter.table, &filter.column);
        if model
            .table(&qc.table)
            .ok()
            .and_then(|t| t.column(&qc.column).ok())
            .is_some()
        {
            columns.push(qc);
        }
    }

    let measures: Vec<String> = definition
        .value_fields
        .iter()
        .filter_map(|v| resolve_measure_name(&v.name, model))
        .collect();

    ObservedObject {
        kind: UsageObjectKind::BiPivot,
        // A pivot lives in the workbook, but it is the CURRENT arrangement of a
        // report rather than something named and put away for reuse.
        saved: false,
        measures: dedup(measures),
        columns: dedup(columns),
    }
}

/// A saved pivot layout's evidence, read out of its DSL text.
///
/// The layout stores `source_bi_measures`, but that list is the field-list
/// context rather than what the layout PLACES, so the DSL is the authority for
/// both halves of the pairing.
pub fn observe_saved_layout(
    layout: &persistence::SavedPivotLayout,
    model: &DataModel,
) -> ObservedObject {
    let (measures, columns) = parse_layout_dsl(&layout.dsl_text, model);
    ObservedObject {
        kind: UsageObjectKind::SavedLayout,
        saved: true,
        measures,
        columns,
    }
}

/// Pull the placed measures and columns out of pivot-layout DSL text.
///
/// Measures are scanned across the WHOLE text: a `[Name]` token is a measure
/// reference wherever it appears, and requiring the model to know the name is
/// what keeps decoration like `[% of Row]` out. Columns are read only from the
/// ROWS / COLUMNS / FILTERS clauses, because those are the ones that place a
/// field on an axis.
fn parse_layout_dsl(dsl: &str, model: &DataModel) -> (Vec<String>, Vec<QualifiedColumn>) {
    let mut measures: Vec<String> = Vec::new();
    let mut rest = dsl;
    while let Some(open) = rest.find('[') {
        rest = &rest[open + 1..];
        let Some(close) = rest.find(']') else { break };
        if let Some(name) = resolve_measure_name(&rest[..close], model) {
            measures.push(name);
        }
        rest = &rest[close + 1..];
    }

    // Clause text is accumulated across continuation lines: the serializer wraps
    // a multi-field VALUES list, and a ROWS list can be wrapped by hand.
    let mut columns: Vec<QualifiedColumn> = Vec::new();
    let mut collecting = false;
    let mut clause = String::new();
    let flush = |clause: &mut String, columns: &mut Vec<QualifiedColumn>| {
        for part in split_top_level(clause) {
            if let Some(qc) = resolve_field_key(&clean_field_token(&part), model) {
                columns.push(qc);
            }
        }
        clause.clear();
    };
    for line in dsl.lines() {
        let trimmed = line.trim_start();
        let upper = trimmed.to_uppercase();
        let opens_axis = ["ROWS", "COLUMNS", "FILTERS"]
            .iter()
            .any(|k| starts_clause(&upper, k));
        let opens_other = ["VALUES", "LAYOUT", "CALC", "SAVE"]
            .iter()
            .any(|k| starts_clause(&upper, k));
        if opens_axis || opens_other {
            if collecting {
                flush(&mut clause, &mut columns);
            }
            collecting = opens_axis;
            if opens_axis {
                let body = trimmed.split_once(':').map(|(_, b)| b).unwrap_or("");
                clause.push_str(body);
            }
            continue;
        }
        if collecting {
            clause.push(' ');
            clause.push_str(trimmed);
        }
    }
    if collecting {
        flush(&mut clause, &mut columns);
    }

    (dedup(measures), dedup(columns))
}

/// Does this upper-cased line open the named clause? The keyword must be
/// followed by a colon or whitespace, so a field literally named `ROWSPAN` does
/// not masquerade as a clause header.
fn starts_clause(upper_line: &str, keyword: &str) -> bool {
    let Some(rest) = upper_line.strip_prefix(keyword) else {
        return false;
    };
    rest.starts_with(':') || rest.trim_start().starts_with(':') || rest.starts_with(' ')
}

/// Split a clause body on commas that are OUTSIDE quotes and parentheses.
///
/// `FILTERS: Geo.Region NOT IN ("Nordics", "DACH")` is ONE field; splitting on
/// every comma would turn its member list into two more field references and
/// invent usage that does not exist.
fn split_top_level(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut in_quotes = false;
    for c in text.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                current.push(c);
            }
            '(' if !in_quotes => {
                depth += 1;
                current.push(c);
            }
            ')' if !in_quotes => {
                depth = depth.saturating_sub(1);
                current.push(c);
            }
            ',' if !in_quotes && depth == 0 => out.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

/// Reduce one clause entry to the bare field name: drop a `LOOKUP` prefix, cut
/// at the first predicate or member list, and unquote.
fn clean_field_token(part: &str) -> String {
    let mut text = part.trim();
    if let Some(stripped) = text.strip_prefix("LOOKUP ") {
        text = stripped.trim_start();
    }
    let cut = text
        .find('=')
        .into_iter()
        .chain(text.find('('))
        .min()
        .unwrap_or(text.len());
    let mut head = text[..cut].trim();
    for suffix in [" NOT IN", " IN", " NOT"] {
        if let Some(stripped) = head.strip_suffix(suffix) {
            head = stripped.trim_end();
        }
    }
    head.trim_matches('"').trim().to_string()
}

fn dedup<T: Ord>(mut items: Vec<T>) -> Vec<T> {
    items.sort();
    items.dedup();
    items
}

// ---------------------------------------------------------------------------
// Collecting from the open workbook
// ---------------------------------------------------------------------------

/// Fold every persisted object in the open workbook into a usage index.
///
/// A POISONED LOCK YIELDS LESS EVIDENCE, NEVER AN ERROR. Usage mining is
/// advisory: it ranks a draft and raises suggestions. Failing the whole
/// `bi_model_strategy` call because one unrelated store panicked earlier would
/// trade a slightly worse ranking for no draft at all.
pub fn collect_usage_from_window(window: &tauri::Window, model: &DataModel) -> UsageIndex {
    use tauri::Manager;

    let app = window.app_handle();
    let mut objects: Vec<ObservedObject> = Vec::new();

    // --- BI pivots ----------------------------------------------------------
    let pivot_state = app.state::<crate::pivot::types::PivotState>();
    // measure sets per pivot, so a slicer or ribbon filter pointing at a pivot
    // can borrow that pivot's measures.
    let mut pivot_measures: HashMap<pivot_engine::PivotId, Vec<String>> = HashMap::new();
    if let (Ok(pivots), Ok(bi_meta)) = (
        pivot_state.pivot_tables.read(),
        pivot_state.bi_metadata.read(),
    ) {
        for (id, (definition, _cache)) in pivots.iter() {
            if !bi_meta.contains_key(id) {
                // A range pivot reads grid cells, not the model; its field names
                // are column headers that happen to look like model columns.
                continue;
            }
            let observed = observe_bi_pivot(definition, model);
            pivot_measures.insert(*id, observed.measures.clone());
            objects.push(observed);
        }
    }

    // --- Slicers ------------------------------------------------------------
    // A slicer names a column but no measure: the measures it constrains are
    // those of the pivots it filters. `connected_sources` is the report
    // connection list; `cache_source_id` is the pivot it draws its items from
    // and is filtered too when nothing else is connected.
    let slicer_state = app.state::<crate::slicer::types::SlicerState>();
    if let Ok(slicers) = slicer_state.slicers.read() {
        for slicer in slicers.values() {
            let Some(column) = resolve_field_key(&slicer.field_name, model) else {
                continue;
            };
            let mut targets: Vec<pivot_engine::PivotId> = slicer
                .connected_sources
                .iter()
                .map(|c| c.source_id)
                .collect();
            if targets.is_empty() {
                targets.push(slicer.cache_source_id);
            }
            let measures: Vec<String> = targets
                .iter()
                .filter_map(|id| pivot_measures.get(id))
                .flat_map(|m| m.iter().cloned())
                .collect();
            if measures.is_empty() {
                continue;
            }
            objects.push(ObservedObject {
                kind: UsageObjectKind::Slicer,
                saved: false,
                measures: dedup(measures),
                columns: vec![column],
            });
        }
    }

    // --- Ribbon filters -----------------------------------------------------
    let ribbon_state = app.state::<crate::ribbon_filter::RibbonFilterState>();
    if let Ok(filters) = ribbon_state.filters.read() {
        for filter in filters.values() {
            let Some(column) = resolve_field_key(&filter.field_name, model) else {
                continue;
            };
            // `bySheet` is treated as workbook-wide here. Resolving a sheet
            // index to the pivots on it needs the grid, and over-counting a
            // filter the user really did place is a far smaller error than
            // dropping it: the worst case is a dimension ranked one place too
            // high in a draft somebody reviews anyway.
            let measures: Vec<String> = match filter.connection_mode {
                crate::ribbon_filter::types::ConnectionMode::Manual => filter
                    .connected_pivots
                    .iter()
                    .filter_map(|id| pivot_measures.get(id))
                    .flat_map(|m| m.iter().cloned())
                    .collect(),
                _ => pivot_measures.values().flat_map(|m| m.iter().cloned()).collect(),
            };
            if measures.is_empty() {
                continue;
            }
            objects.push(ObservedObject {
                kind: UsageObjectKind::RibbonFilter,
                saved: false,
                measures: dedup(measures),
                columns: vec![column],
            });
        }
    }

    // --- Saved pivot layouts ------------------------------------------------
    let app_state = app.state::<crate::AppState>();
    if let Ok(layouts) = app_state.pivot_layouts.read() {
        for layout in layouts.iter() {
            let observed = observe_saved_layout(layout, model);
            if observed.measures.is_empty() || observed.columns.is_empty() {
                continue;
            }
            objects.push(observed);
        }
    }

    UsageIndex::build(&objects, model)
}

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

/// Where the strategy document and the workbook disagree about how a measure is
/// looked at.
///
/// BOTH ARE WARNINGS, NEVER ERRORS, and nothing here is auto-applied. Usage is
/// evidence about habit, not about correctness: a `neverSliceBy` pair the
/// workbook uses may be a stale pivot somebody should delete, or a rule somebody
/// should relax, and only a person knows which. Refusing the document over it
/// would let a pivot nobody has opened in a year block a save.
pub fn divergence_findings(doc: &StrategyDoc, usage: &UsageIndex) -> Vec<Finding> {
    let mut findings: Vec<Finding> = Vec::new();

    for (measure, entry) in &doc.measures {
        for column in &entry.never_slice_by {
            let score = usage.score(measure, column);
            if score == 0 {
                continue;
            }
            findings.push(Finding {
                severity: Severity::Warning,
                code: "never-slice-by-in-use".to_string(),
                path: format!("measures['{measure}'].neverSliceBy"),
                message: format!(
                    "the strategy says never to slice '{measure}' by {column}, but this workbook \
                     already does in {} place(s); either the objects are stale or the rule is",
                    score
                ),
            });
        }

        let mut candidates: Vec<(&QualifiedColumn, u32)> = usage
            .pairings
            .iter()
            .filter(|p| &p.measure == measure)
            .map(|p| (&p.column, usage.score(measure, &p.column)))
            .filter(|&(column, score)| {
                score >= HIGH_USE_SCORE
                    && !entry.analysis_dimensions.contains(column)
                    // A pair the strategy has deliberately forbidden is reported
                    // by the check above; saying it twice would read as two
                    // separate problems.
                    && !entry.never_slice_by.contains(column)
            })
            .collect();
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        candidates.dedup_by(|a, b| a.0 == b.0);

        for (column, score) in candidates {
            findings.push(Finding {
                severity: Severity::Warning,
                code: "analysis-dimension-missing".to_string(),
                path: format!("measures['{measure}'].analysisDimensions"),
                message: format!(
                    "this workbook slices '{measure}' by {column} (usage score {score}), but it is \
                     not one of its analysis dimensions; add it, or leave it out deliberately"
                ),
            });
        }
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::strategy::MeasureStrategy;
    use bi_engine::{sum_measure, Column, DataType, Relationship, Table};

    /// A model whose dimension table name CONTAINS A DOT, which is the whole
    /// point of the split test below.
    fn a_dotted_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "BI.fact_sales",
                    vec![
                        Column::new("amount", DataType::Float64),
                        Column::new("customer_id", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "BI.dim_customer",
                    vec![
                        Column::new("customer_id", DataType::Int64),
                        Column::new("fullname", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "sales_customer",
                "BI.fact_sales",
                "customer_id",
                "BI.dim_customer",
                "customer_id",
            ))
            .add_measure(sum_measure("Revenue", "BI.fact_sales", "amount"))
            .build()
            .expect("the dotted fixture builds")
    }

    #[test]
    fn a_dotted_table_name_is_split_against_the_models_table_list_not_on_the_first_dot() {
        let model = a_dotted_model();

        // A first-dot split reads this as table "BI", which is in no model, and
        // the pairing vanishes without a word.
        let resolved = resolve_field_key("BI.dim_customer.fullname", &model)
            .expect("the longest matching table name must win");
        assert_eq!(resolved.table, "BI.dim_customer");
        assert_eq!(resolved.column, "fullname");

        // The same key inside a saved layout, end to end.
        let layout = persistence::SavedPivotLayout {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Customers".into(),
            dsl_text: "ROWS:    BI.dim_customer.fullname\nVALUES:  [Revenue]".into(),
            description: None,
            source_type: "bi".into(),
            source_table_name: None,
            source_bi_tables: vec!["BI.dim_customer".into()],
            source_bi_measures: vec!["Revenue".into()],
            created_at: 0.0,
            updated_at: 0.0,
        };
        let observed = observe_saved_layout(&layout, &model);
        assert_eq!(observed.measures, vec!["Revenue".to_string()]);
        assert_eq!(
            observed.columns,
            vec![QualifiedColumn::new("BI.dim_customer", "fullname")]
        );

        // And a key that names no model table at all is dropped rather than
        // guessed at.
        assert_eq!(resolve_field_key("Nowhere.column", &model), None);
    }

    #[test]
    fn a_saved_layout_outweighs_a_single_live_pivot() {
        let model = a_dotted_model();
        let column = QualifiedColumn::new("BI.dim_customer", "fullname");
        let live = ObservedObject {
            kind: UsageObjectKind::BiPivot,
            saved: false,
            measures: vec!["Revenue".into()],
            columns: vec![column.clone()],
        };
        let saved = ObservedObject {
            kind: UsageObjectKind::SavedLayout,
            saved: true,
            ..live.clone()
        };
        assert_eq!(UsageIndex::build(&[live.clone()], &model).score("Revenue", &column), 1);
        assert_eq!(UsageIndex::build(&[saved], &model).score("Revenue", &column), SAVED_WEIGHT);
        // Two live objects count as two, so the threshold means "seen twice, or
        // filed once".
        assert_eq!(
            UsageIndex::build(&[live.clone(), live], &model).score("Revenue", &column),
            2
        );
    }

    #[test]
    fn a_filter_member_list_is_not_mistaken_for_more_fields() {
        // Splitting this on every comma invents two extra field references.
        let parts = split_top_level(
            r#"BI.dim_customer.fullname NOT IN ("a", "b"), BI.dim_customer.customer_id"#,
        );
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert_eq!(clean_field_token(&parts[0]), "BI.dim_customer.fullname");
        assert_eq!(clean_field_token(&parts[1]), "BI.dim_customer.customer_id");
    }

    #[test]
    fn a_never_slice_by_pair_the_workbook_uses_is_reported_and_a_high_use_pair_absent_is_too() {
        let model = a_dotted_model();
        let name = QualifiedColumn::new("BI.dim_customer", "fullname");
        let id = QualifiedColumn::new("BI.dim_customer", "customer_id");
        let usage = UsageIndex::build(
            &[
                ObservedObject {
                    kind: UsageObjectKind::SavedLayout,
                    saved: true,
                    measures: vec!["Revenue".into()],
                    columns: vec![name.clone(), id.clone()],
                },
            ],
            &model,
        );

        let mut doc = StrategyDoc::default();
        doc.measures.insert(
            "Revenue".into(),
            MeasureStrategy {
                never_slice_by: vec![name.clone()],
                ..Default::default()
            },
        );

        let findings = divergence_findings(&doc, &usage);
        assert!(
            findings.iter().all(|f| f.severity == Severity::Warning),
            "divergence is evidence about habit, never a refusal"
        );
        assert!(
            findings
                .iter()
                .any(|f| f.code == "never-slice-by-in-use" && f.message.contains("fullname")),
            "{findings:?}"
        );
        assert!(
            findings
                .iter()
                .any(|f| f.code == "analysis-dimension-missing" && f.message.contains("customer_id")),
            "{findings:?}"
        );
        // The forbidden pair is reported ONCE, as a forbidden pair - not also as
        // a missing analysis dimension.
        assert_eq!(
            findings
                .iter()
                .filter(|f| f.message.contains("fullname"))
                .count(),
            1,
            "{findings:?}"
        );
    }

    #[test]
    fn a_measure_the_workbook_never_reports_gets_no_cadence_and_no_priority() {
        // The absence matters, and what `infer` does with it has CHANGED: it
        // falls back to Monthly for the cadence, and it now SEEDS a model-wide
        // priority rather than leaving it empty (`seed_priority` in infer.rs) —
        // measures carrying a KPI first, then the model's own DECLARATION order.
        //
        // The objection this comment used to record still stands and is
        // answered rather than ignored: an ALPHABETICAL ranking would be an
        // order nobody chose wearing the clothes of one somebody did.
        // Declaration order is the author's, and without any seed the report
        // generator had nothing to lead with at all.
        //
        // What is asserted here is unchanged: `UsageIndex` itself invents
        // nothing. The seed lives in `infer`, and usage wins outright whenever
        // it has anything to say.
        let usage = UsageIndex::default();
        assert_eq!(usage.cadence_for("Revenue"), None);
        assert!(usage.ranked_measures().is_empty());
    }
}
