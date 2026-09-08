//! FILENAME: app/src-tauri/src/insights/strategy/validate.rs
// PURPOSE: Refuse a strategy document that would make the insights engine lie,
//          warn about one that has merely gone stale, and run the consultant's
//          own inline assertions so their file gates itself.
// CONTEXT: The severity split is the design, not decoration.
//
//          An ERROR is a document that would produce a STATEMENT THAT IS WRONG:
//          a rule pointing at a measure that no longer exists, a rule scoped on
//          an invoice id, `lowerIsBetter` on a measure whose own KPI bands run
//          the other way, two equal-specificity rules whose winner is decided by
//          iteration order. None of those degrade gracefully - each one puts a
//          confident sentence in front of a reader, and the sentence is false.
//
//          A WARNING is a document that has gone STALE or is UNFINISHED: an entry
//          for a deleted measure, `reviewed: false`, a member that was renamed.
//          The engine still says only true things; it just says less than the
//          author intended.
//
//          THE INLINE TESTS ARE WHY THIS FILE HAS TEETH. A consultant writes
//          "Returns in the Refunds department, up 5000, must come out favourable,
//          and rule 'refunds-dept' must be what decided it" and that assertion is
//          re-run against the resolver on every validation. Asserting the reason
//          as well as the answer is the point: a test that only checks the answer
//          passes for the wrong reason as soon as an unrelated rule starts winning.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::overlap::check_overlaps;
use super::resolve::{point_from_scope, resolve, ModelFacts, ResolvedMeasure};
use super::types::{
    AggregationSpec, Attribute, Direction, ExpectedStatus, Materiality, QualifiedColumn, Role,
    Scope, ScopeValue, StrategyDoc, Target, TestGiven, MAX_STRATEGY_DOC_BYTES,
};

/// Is this column a level of ANY hierarchy — the model's own, or one the
/// document declares?
///
/// The union, and not just the document's copy. `TableStrategy::hierarchies` is
/// written by `infer`; a document a person wrote by hand, or one written before
/// a hierarchy was added to the model, carries none — and scoping a rule on a
/// real hierarchy level was being refused as `scope-column-role` in exactly that
/// case. Consulting both can only turn a refusal into a pass.
fn in_a_hierarchy(facts: &ModelFacts, doc: &StrategyDoc, col: &QualifiedColumn) -> bool {
    doc.in_a_hierarchy(col) || facts.in_a_hierarchy(col)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// The document must be refused.
    Error,
    /// The document applies, but something has gone stale or is unfinished.
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Finding {
    pub severity: Severity,
    /// A stable kebab-case code, so a UI can group and a test can assert on
    /// something other than prose.
    pub code: String,
    /// Where in the document, e.g. `rules[2].scope` or `measures['Revenue']`.
    pub path: String,
    pub message: String,
}

impl Finding {
    fn error(code: &str, path: String, message: String) -> Self {
        Self {
            severity: Severity::Error,
            code: code.to_string(),
            path,
            message,
        }
    }

    fn warning(code: &str, path: String, message: String) -> Self {
        Self {
            severity: Severity::Warning,
            code: code.to_string(),
            path,
            message,
        }
    }
}

/// Does any finding refuse the document?
pub fn is_refused(findings: &[Finding]) -> bool {
    findings.iter().any(|f| f.severity == Severity::Error)
}

// ---------------------------------------------------------------------------
// Inline tests
// ---------------------------------------------------------------------------

/// What the resolver actually said about a hypothetical movement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestOutcome {
    pub status: ExpectedStatus,
    /// The rule that produced the outcome, when a rule did.
    pub decided_by: Option<String>,
}

/// Is a movement big enough to be worth a sentence?
///
/// A relative materiality with no baseline is NOT treated as immaterial: the test
/// simply did not supply what the check needs, and silently swallowing the
/// movement would be the validator inventing a verdict.
fn is_material(r: &ResolvedMeasure, given: &TestGiven) -> bool {
    match r.materiality.as_ref().map(|a| &a.value) {
        None => true,
        Some(Materiality::Absolute { value }) => given.delta.abs() >= *value,
        Some(Materiality::Relative { value }) => match given.baseline {
            Some(b) if b != 0.0 => (given.delta / b).abs() >= *value,
            _ => true,
        },
    }
}

/// Judge one hypothetical movement against a resolved measure.
pub fn judge(r: &ResolvedMeasure, given: &TestGiven) -> TestOutcome {
    // Rule 4 first: a withheld direction means the engine says nothing about
    // favourability, whatever the numbers do.
    if let Some(s) = r.suppression_of(Attribute::Direction) {
        return TestOutcome {
            status: ExpectedStatus::Suppressed,
            decided_by: Some(s.rule.clone()),
        };
    }

    let Some(direction) = r.direction.as_ref() else {
        return TestOutcome {
            status: ExpectedStatus::Neutral,
            decided_by: None,
        };
    };

    if !is_material(r, given) {
        // Materiality is what decided this, so materiality's provenance is what
        // the test should be allowed to assert on.
        return TestOutcome {
            status: ExpectedStatus::Neutral,
            decided_by: r
                .materiality
                .as_ref()
                .and_then(|a| a.rule_id())
                .or_else(|| direction.rule_id())
                .map(str::to_string),
        };
    }

    let status = match direction.value {
        Direction::Neutral => ExpectedStatus::Neutral,
        Direction::HigherIsBetter => favourable_if(given.delta > 0.0, given.delta),
        Direction::LowerIsBetter => favourable_if(given.delta < 0.0, given.delta),
        Direction::TargetBand => match (given.value, r.target.as_ref().map(|a| &a.value)) {
            (Some(v), Some(Target::Band { low, high })) => {
                if v >= *low && v <= *high {
                    ExpectedStatus::Favourable
                } else {
                    ExpectedStatus::Unfavourable
                }
            }
            // A band direction with no band to compare against cannot be judged,
            // and guessing is exactly what this subtree exists to prevent.
            _ => ExpectedStatus::Neutral,
        },
    };

    TestOutcome {
        status,
        decided_by: direction.rule_id().map(str::to_string),
    }
}

fn favourable_if(good: bool, delta: f64) -> ExpectedStatus {
    if delta == 0.0 {
        ExpectedStatus::Neutral
    } else if good {
        ExpectedStatus::Favourable
    } else {
        ExpectedStatus::Unfavourable
    }
}

/// Run every inline test and report the failures as validation errors.
pub fn run_inline_tests(facts: &ModelFacts, doc: &StrategyDoc) -> Vec<Finding> {
    let mut out = Vec::new();
    for (i, t) in doc.tests.iter().enumerate() {
        let path = format!("tests[{i}]");
        if !facts.measures.contains_key(&t.measure) {
            // Already reported as an unknown measure; running it would only add
            // a second, less informative finding.
            continue;
        }
        let point = point_from_scope(&t.scope);
        let resolved = resolve(facts, doc, &t.measure, &point);
        let actual = judge(&resolved, &t.given);

        if actual.status != t.expect.status {
            out.push(Finding::error(
                "inline-test-failed",
                path.clone(),
                format!(
                    "the test for '{}' expects '{}' but the strategy resolves to '{}'",
                    t.measure, t.expect.status, actual.status
                ),
            ));
            continue;
        }
        if let Some(expected_rule) = &t.expect.decided_by {
            if actual.decided_by.as_deref() != Some(expected_rule.as_str()) {
                out.push(Finding::error(
                    "inline-test-failed",
                    path,
                    format!(
                        "the test for '{}' expects rule '{}' to decide it, but it was decided by {}",
                        t.measure,
                        expected_rule,
                        actual
                            .decided_by
                            .as_deref()
                            .map(|r| format!("rule '{r}'"))
                            .unwrap_or_else(|| "no rule at all".to_string())
                    ),
                ));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

/// `YYYY-MM-DD`, zero padded. overlap.rs compares these bounds as strings, which
/// is exact for this form and silently wrong for any other, so a malformed bound
/// is an error rather than a nicety.
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// The wire spelling of a direction, for a message a person reads.
fn direction_label(d: Direction) -> &'static str {
    match d {
        Direction::HigherIsBetter => "higherIsBetter",
        Direction::LowerIsBetter => "lowerIsBetter",
        Direction::TargetBand => "targetBand",
        Direction::Neutral => "neutral",
    }
}

/// Every spelling of a `byDimension` key that `is_additive_over` will match.
///
/// It must stay EXACTLY the three that `insights::model::is_additive_over`
/// tries, in the same order, or this validator would bless a key the resolver
/// then fails to find.
fn aggregation_dimension_is_known(facts: &ModelFacts, key: &str) -> bool {
    if let Ok(qc) = key.parse::<QualifiedColumn>() {
        if facts.has_column(&qc) {
            return true;
        }
    }
    if facts.tables.values().any(|t| t.columns.contains(key)) {
        return true;
    }
    facts.has_table(key)
}

/// Refuse a per-dimension additivity keyed on something the model does not have.
///
/// THIS IS A SILENT WRONG ANSWER, not a missing feature. `is_additive_over`
/// tries `Table[Column]`, the bare column and the bare table, and FALLS BACK TO
/// `default` when none match - so `"Dat": "lastValue"` on a closing balance
/// leaves the measure additive over Date, and the engine goes on to claim the
/// balance's share of an annual total.
fn validate_aggregation(
    facts: &ModelFacts,
    spec: &AggregationSpec,
    path: &str,
    out: &mut Vec<Finding>,
) {
    for key in spec.by_dimension.keys() {
        if aggregation_dimension_is_known(facts, key) {
            continue;
        }
        out.push(Finding::error(
            "unknown-aggregation-dimension",
            path.to_string(),
            format!(
                "byDimension is keyed on '{key}', which is not a table, not a column and not a \
                 Table[Column] in the model. An unmatched key falls back to the default \
                 additivity in silence, so a semi-additive measure would be summed along the \
                 dimension this entry was written to protect. Write the table name, the column \
                 name, or Table[Column]"
            ),
        ));
    }
}

fn validate_scope(
    facts: &ModelFacts,
    doc: &StrategyDoc,
    scope: &Scope,
    path: &str,
    out: &mut Vec<Finding>,
) {
    for (col, value) in scope {
        if !facts.has_table(&col.table) {
            out.push(Finding::error(
                "unknown-table",
                path.to_string(),
                format!("scope names '{col}', but the model has no table '{}'", col.table),
            ));
            continue;
        }
        if !facts.has_column(col) {
            out.push(Finding::error(
                "unknown-column",
                path.to_string(),
                format!(
                    "scope names '{col}', but table '{}' has no column '{}'",
                    col.table, col.column
                ),
            ));
            continue;
        }
        match doc.role_of(col) {
            Some(role) if !role.may_scope() && !in_a_hierarchy(facts, doc, col) => {
                out.push(Finding::error(
                    "scope-column-role",
                    path.to_string(),
                    format!(
                        "'{col}' has role '{}', so it cannot scope a rule - only analysis, filter \
                         and hierarchy columns can. Keys and labels identify rows; scoping by one \
                         produces a rule that matches a single record",
                        serde_json::to_string(&role).unwrap_or_default().trim_matches('"')
                    ),
                ));
            }
            None => out.push(Finding::warning(
                "undeclared-scope-column",
                path.to_string(),
                format!(
                    "'{col}' scopes a rule but the document declares no role for it, so nothing \
                     checks that scoping by it is meaningful"
                ),
            )),
            _ => {}
        }

        match value {
            ScopeValue::Members(members) => {
                if members.is_empty() {
                    out.push(Finding::error(
                        "empty-scope",
                        path.to_string(),
                        format!("'{col}' is constrained to no members, so the scope is empty"),
                    ));
                }
                if let Some(known) = facts.known_members(col) {
                    for m in members {
                        if !known.contains(m) {
                            out.push(Finding::warning(
                                "unknown-member",
                                path.to_string(),
                                format!(
                                    "'{col}' is scoped to member '{m}', which the model no longer has"
                                ),
                            ));
                        }
                    }
                }
            }
            ScopeValue::DateRange { from, to } => {
                // An absent `to` is "onwards" and needs no checking; only a
                // bound that is PRESENT can be malformed.
                for bound in [Some(from), to.as_ref()].into_iter().flatten() {
                    if !is_iso_date(bound) {
                        out.push(Finding::error(
                            "malformed-date-range",
                            path.to_string(),
                            format!(
                                "'{col}' has the date bound '{bound}', which is not YYYY-MM-DD; \
                                 the overlap checker compares these bounds as text and would \
                                 wrongly conclude two rules are disjoint"
                            ),
                        ));
                    }
                }
                if let Some(to) = to {
                    if is_iso_date(from) && is_iso_date(to) && from > to {
                        out.push(Finding::error(
                            "empty-scope",
                            path.to_string(),
                            format!("'{col}' runs from '{from}' to '{to}', which is empty"),
                        ));
                    }
                }
            }
        }
    }
}

/// Validate a whole document against the model it annotates.
pub fn validate(facts: &ModelFacts, doc: &StrategyDoc) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();

    // --- model-wide ----------------------------------------------------------
    if let Some(axis) = &doc.model.default_time_axis {
        if !facts.has_column(axis) {
            out.push(Finding::error(
                "unknown-column",
                "model.defaultTimeAxis".into(),
                format!("the default time axis '{axis}' is not a column in the model"),
            ));
        } else if facts.date_table.as_deref() != Some(axis.table.as_str()) {
            out.push(Finding::warning(
                "time-axis-not-date-table",
                "model.defaultTimeAxis".into(),
                format!(
                    "the default time axis '{axis}' is not in the marked date table, so \
                     time intelligence will not use it"
                ),
            ));
        }
    }
    if let Some(fys) = &doc.model.fiscal_year_start {
        let ok = fys.len() == 5
            && fys.as_bytes()[2] == b'-'
            && fys[0..2].parse::<u32>().map(|m| (1..=12).contains(&m)).unwrap_or(false)
            && fys[3..5].parse::<u32>().map(|d| (1..=31).contains(&d)).unwrap_or(false);
        if !ok {
            // Refused at the door because a malformed value here would
            // mis-label a whole report rather than fail loudly, once anything
            // reads it.
            //
            // NOTHING READS IT YET. An earlier version of this comment said
            // "every period bucket in every fact is derived from this", which
            // was not true when it was written: `fiscal_year_start` has no
            // consumer outside this check — the planner buckets by cadence and
            // never asks where the fiscal year starts. Keeping the format check
            // is right (a value stored malformed is a trap for whoever wires it
            // up), but the reason had to stop overstating itself.
            out.push(Finding::error(
                "malformed-fiscal-year-start",
                "model.fiscalYearStart".into(),
                format!("'{fys}' is not an MM-DD fiscal year start"),
            ));
        }
    }
    for (i, m) in doc.model.priority.iter().enumerate() {
        if !facts.measures.contains_key(m) {
            out.push(Finding::error(
                "unknown-measure",
                format!("model.priority[{i}]"),
                format!("priority names '{m}', which is not a measure in the model"),
            ));
        }
    }

    // --- tables --------------------------------------------------------------
    for (table, ts) in &doc.tables {
        let path = format!("tables['{table}']");
        if !facts.has_table(table) {
            out.push(Finding::warning(
                "orphan-table",
                path,
                format!("'{table}' has a strategy entry but no longer exists in the model"),
            ));
            continue;
        }
        if !ts.reviewed {
            out.push(Finding::warning(
                "unreviewed",
                path.clone(),
                format!("'{table}' has not been reviewed by a human"),
            ));
        }
        if let Some(label) = &ts.label_column {
            if !facts.has_column(&QualifiedColumn::new(table, label)) {
                out.push(Finding::error(
                    "unknown-column",
                    format!("{path}.labelColumn"),
                    format!("'{table}' names label column '{label}', which does not exist"),
                ));
            }
        }
        for column in ts.columns.keys() {
            if !facts.has_column(&QualifiedColumn::new(table, column)) {
                out.push(Finding::error(
                    "unknown-column",
                    format!("{path}.columns['{column}']"),
                    format!("'{table}' has no column '{column}'"),
                ));
            }
        }
        for (h, chain) in ts.hierarchies.iter().enumerate() {
            for column in chain {
                if !facts.has_column(&QualifiedColumn::new(table, column)) {
                    out.push(Finding::error(
                        "unknown-column",
                        format!("{path}.hierarchies[{h}]"),
                        format!("hierarchy names '{table}[{column}]', which does not exist"),
                    ));
                }
            }
        }
    }

    // --- measures ------------------------------------------------------------
    for (measure, ms) in &doc.measures {
        let path = format!("measures['{measure}']");
        let Some(mf) = facts.measures.get(measure) else {
            out.push(Finding::warning(
                "orphan-measure",
                path,
                format!("'{measure}' has a strategy entry but no longer exists in the model"),
            ));
            continue;
        };
        if !ms.reviewed {
            out.push(Finding::warning(
                "unreviewed",
                path.clone(),
                format!("'{measure}' has not been reviewed by a human"),
            ));
        }

        // The contradiction that produces a confidently backwards sentence.
        //
        // The KPI's own answer comes from the ORDER ITS BAND STATUSES RUN IN, not
        // from its thresholds: the engine refuses a KPI whose thresholds do not
        // ascend, so a threshold-only reading called every KPI higher-is-better
        // and this check could never fire against a churn KPI.
        if let (Some(declared), Some(kpi)) = (ms.direction, mf.kpi.as_ref()) {
            let derived = kpi.direction();
            let opposed = matches!(
                (declared, derived),
                (Direction::LowerIsBetter, Some(Direction::HigherIsBetter))
                    | (Direction::HigherIsBetter, Some(Direction::LowerIsBetter))
            );
            if opposed {
                let derived = derived.expect("opposed implies a derived direction");
                out.push(Finding::error(
                    "direction-contradicts-kpi",
                    format!("{path}.direction"),
                    format!(
                        "measure '{measure}' is declared {}, but its own KPI '{}' has bands \
                         {} - whose statuses say {} as the ratio grows. One of the two is \
                         wrong and the engine must not choose",
                        direction_label(declared),
                        kpi.name,
                        kpi.band_summary(),
                        direction_label(derived),
                    ),
                ));
            }
        }

        // TWO PLACES TO DEFINE A TARGET IS TWO PLACES FOR IT TO DRIFT. A literal
        // in the strategy entry beside a constant on the model's KPI means the
        // variance line and the KPI badge on the same measure disagree, silently,
        // in the same report. `{"type": "kpi"}` is the spelling that cannot drift.
        if let (Some(Target::Literal { value }), Some(kpi)) = (&ms.target, mf.kpi.as_ref()) {
            if let Some(kpi_target) = kpi.target {
                let scale = value.abs().max(kpi_target.abs()).max(1.0);
                if (value - kpi_target).abs() > 1e-9 * scale {
                    out.push(Finding::error(
                        "target-contradicts-kpi",
                        format!("{path}.target"),
                        format!(
                            "'{measure}' declares the literal target {value} in the strategy \
                             document, but the model's KPI '{}' declares the constant target \
                             {kpi_target}. Two definitions of one goal drift apart; write \
                             {{\"type\": \"kpi\"}} to inherit the KPI's, or change the KPI",
                            kpi.name
                        ),
                    ));
                }
            }
        }

        if let Some(agg) = ms.aggregation.as_ref() {
            validate_aggregation(facts, agg, &format!("{path}.aggregation"), &mut out);
        }
        if ms.direction == Some(Direction::TargetBand)
            && !matches!(ms.target, Some(Target::Band { .. }))
        {
            out.push(Finding::warning(
                "target-band-without-band",
                format!("{path}.direction"),
                format!(
                    "'{measure}' is targetBand but declares no band target, so no movement can \
                     ever be judged favourable"
                ),
            ));
        }
        if let Some(Target::Measure { r#ref }) = &ms.target {
            if !facts.measures.contains_key(r#ref) {
                out.push(Finding::error(
                    "unknown-measure",
                    format!("{path}.target"),
                    format!(
                        "'{}' targets measure '{}', which is not in the model",
                        measure, r#ref
                    ),
                ));
            }
        }

        // What the EXECUTOR can join in one hop, which is what the planner may
        // ask for. Wider reachability is used further down for a different
        // question and must not be confused with this one.
        let one_hop = mf
            .fact_table
            .as_ref()
            .map(|t| facts.directly_related_tables(t))
            .unwrap_or_default();

        for (i, col) in ms.analysis_dimensions.iter().enumerate() {
            let p = format!("{path}.analysisDimensions[{i}]");
            if !facts.has_column(col) {
                out.push(Finding::error(
                    "unknown-column",
                    p,
                    format!("'{col}' is not a column in the model"),
                ));
                continue;
            }
            // A snowflaked attribute is REPORTED, not dropped. The whole reason
            // this is a warning rather than an error is that the document is
            // right about what the user wants and the engine is what cannot do
            // it yet; refusing the document would make the author delete a true
            // statement to work around a limitation.
            if !one_hop.is_empty() && !one_hop.contains(&col.table) {
                out.push(Finding::warning(
                    "unreachable-in-v1",
                    p.clone(),
                    format!(
                        "'{col}' is not on a table directly related to '{measure}'s fact table, \
                         and the query engine refuses relationship paths longer than one hop, so \
                         this breakdown cannot be computed yet"
                    ),
                ));
            }
            // A LABEL IS NOT AN ANALYSIS DIMENSION, AND A KEY NEVER WAS.
            //
            // A label is what a reader recognises ONE ROW by, so breaking a
            // measure down by it produces one fact per record: a report that is
            // technically true and completely useless. The role arm below has
            // refused `label` from the start; what is added here is the table's
            // `labelColumn` POINTER, which says the same thing about a column
            // the document never gave a role of its own.
            //
            // The pointer is the WEAKER of the two declarations and is treated
            // that way. `role` is a statement about one column; `labelColumn` is
            // written by `infer` from a NAME HEURISTIC (`label_score`: does the
            // last word read as "name"), and refusing a document outright on a
            // name heuristic is the confident-wrong this layer exists to avoid.
            // So an explicit `analysis`, `filter` or `hierarchy` role on the same
            // column WINS: that is a person stating, with the data in front of
            // them, that this column really is an axis - the cardinality call
            // nothing in this codebase can make on its own.
            let is_label_column = doc
                .tables
                .get(&col.table)
                .and_then(|t| t.label_column.as_deref())
                == Some(col.column.as_str());
            let refusal: Option<String> = match doc.role_of(col) {
                Some(role) if matches!(role, Role::Key | Role::Label | Role::Ignore) => {
                    Some(format!(
                        "'{col}' is declared as a {} column",
                        serde_json::to_string(&role).unwrap_or_default().trim_matches('"')
                    ))
                }
                None if is_label_column => Some(format!(
                    "'{col}' is the label column of table '{}' - what a reader recognises one \
                     of its rows by - and the document declares no role of its own for it",
                    col.table
                )),
                _ => None,
            };
            // A hierarchy level is an axis whoever declared the hierarchy said
            // was one, in the document or in the model, and that outranks both
            // spellings above - exactly as it already did for the role alone.
            if let Some(reason) = refusal {
                if !in_a_hierarchy(facts, doc, col) {
                    out.push(Finding::error(
                        "analysis-dimension-role",
                        p,
                        format!(
                            "{reason}, so breaking '{measure}' down by it produces one row per \
                             record rather than an insight"
                        ),
                    ));
                }
            }
        }

        let reachable = mf
            .fact_table
            .as_ref()
            .map(|t| facts.reachable_tables(t))
            .unwrap_or_default();
        for (i, col) in ms.never_slice_by.iter().enumerate() {
            let p = format!("{path}.neverSliceBy[{i}]");
            if !facts.has_column(col) {
                out.push(Finding::error(
                    "unknown-column",
                    p,
                    format!("'{col}' is not a column in the model"),
                ));
                continue;
            }
            if !reachable.is_empty() && !reachable.contains(&col.table) {
                out.push(Finding::warning(
                    "unreachable-never-slice-by",
                    p,
                    format!(
                        "'{measure}' forbids slicing by '{col}', but no relationship path reaches \
                         '{}' from its fact table, so nothing could have sliced by it anyway",
                        col.table
                    ),
                ));
            }
        }
    }

    // --- rules ---------------------------------------------------------------
    let mut seen_ids: BTreeMap<&str, usize> = BTreeMap::new();
    // A column constrained as members here and as a date range there cannot be
    // reconciled by enumeration, which forces overlap.rs into its conservative
    // branch and reports collisions that may not exist.
    let mut constraint_kinds: BTreeMap<QualifiedColumn, BTreeSet<&'static str>> = BTreeMap::new();

    for (i, rule) in doc.rules.iter().enumerate() {
        let path = format!("rules[{i}]");
        *seen_ids.entry(rule.id.as_str()).or_insert(0) += 1;
        if !facts.measures.contains_key(&rule.measure) {
            out.push(Finding::error(
                "unknown-measure",
                path.clone(),
                format!(
                    "rule '{}' annotates measure '{}', which is not in the model",
                    rule.id, rule.measure
                ),
            ));
        }
        if rule.set.is_empty() {
            out.push(Finding::warning(
                "empty-rule",
                path.clone(),
                format!("rule '{}' sets nothing, so it has no effect", rule.id),
            ));
        }
        if let Some(Target::Measure { r#ref }) = &rule.set.target {
            if !facts.measures.contains_key(r#ref) {
                out.push(Finding::error(
                    "unknown-measure",
                    format!("{path}.set.target"),
                    format!(
                        "rule '{}' targets measure '{}', which is not in the model",
                        rule.id, r#ref
                    ),
                ));
            }
        }
        if let Some(agg) = rule.set.aggregation.as_ref() {
            // A rule can override aggregation too, and a typo there is the same
            // silent fallback - narrowed to one scope, which makes it harder to
            // notice rather than easier.
            validate_aggregation(facts, agg, &format!("{path}.set.aggregation"), &mut out);
        }
        for (col, v) in &rule.scope {
            constraint_kinds.entry(col.clone()).or_default().insert(match v {
                ScopeValue::Members(_) => "members",
                ScopeValue::DateRange { .. } => "dateRange",
            });
        }
        validate_scope(facts, doc, &rule.scope, &format!("{path}.scope"), &mut out);
    }
    for (id, count) in seen_ids {
        if count > 1 {
            out.push(Finding::error(
                "duplicate-rule-id",
                "rules".into(),
                format!(
                    "rule id '{id}' is used {count} times; ids are how a finding names the rule \
                     that produced it, so they must be unique"
                ),
            ));
        }
    }
    for (col, kinds) in constraint_kinds {
        if kinds.len() > 1 {
            out.push(Finding::warning(
                "mixed-scope-constraint",
                "rules".into(),
                format!(
                    "'{col}' is constrained as a member list in one rule and as a date range in \
                     another; the overlap checker cannot prove those disjoint and will report \
                     collisions conservatively"
                ),
            ));
        }
    }

    // --- periods -------------------------------------------------------------
    let mut period_ids: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, p) in doc.periods.iter().enumerate() {
        let path = format!("periods[{i}]");
        *period_ids.entry(p.id.as_str()).or_insert(0) += 1;
        if let Some(m) = &p.measure {
            if !facts.measures.contains_key(m) {
                out.push(Finding::error(
                    "unknown-measure",
                    path.clone(),
                    format!("period '{}' annotates measure '{m}', which is not in the model", p.id),
                ));
            }
        }
        validate_scope(facts, doc, &p.scope, &format!("{path}.scope"), &mut out);
    }
    for (id, count) in period_ids {
        if count > 1 {
            out.push(Finding::warning(
                "duplicate-period-id",
                "periods".into(),
                format!("period id '{id}' is used {count} times"),
            ));
        }
    }

    // --- tests ---------------------------------------------------------------
    for (i, t) in doc.tests.iter().enumerate() {
        let path = format!("tests[{i}]");
        if !facts.measures.contains_key(&t.measure) {
            out.push(Finding::error(
                "unknown-measure",
                path.clone(),
                format!("the test names measure '{}', which is not in the model", t.measure),
            ));
        }
        if let Some(rule_id) = &t.expect.decided_by {
            if !doc.rules.iter().any(|r| &r.id == rule_id) {
                out.push(Finding::error(
                    "unknown-rule",
                    format!("{path}.expect.decidedBy"),
                    format!("the test expects rule '{rule_id}' to decide it, but no such rule exists"),
                ));
            }
        }
        validate_scope(facts, doc, &t.scope, &format!("{path}.scope"), &mut out);
    }

    // --- overlaps ------------------------------------------------------------
    for conflict in check_overlaps(doc) {
        out.push(Finding::error("rule-overlap", "rules".into(), conflict.message()));
    }

    // --- the consultant's own assertions -------------------------------------
    out.extend(run_inline_tests(facts, doc));

    // --- size ----------------------------------------------------------------
    match serde_json::to_vec(doc) {
        Ok(bytes) if bytes.len() > MAX_STRATEGY_DOC_BYTES => out.push(Finding::error(
            "document-too-large",
            "".into(),
            format!(
                "the document serializes to {} bytes, over the {MAX_STRATEGY_DOC_BYTES}-byte \
                 per-key extension-data cap; a document that does not fit is stored TRUNCATED, \
                 which parses as a different and smaller strategy",
                bytes.len()
            ),
        )),
        Ok(_) => {}
        Err(e) => out.push(Finding::error(
            "unserializable",
            "".into(),
            format!("the document cannot be serialized: {e}"),
        )),
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::strategy::resolve::{
        BandStatus, KpiBand, KpiFacts, MeasureFacts, TableFacts,
    };
    use crate::insights::strategy::types::{
        Additivity, AttributeSet, Cadence, ColumnStrategy, MeasureStrategy, PeriodAnnotation, Rule,
        StrategyTest, TableStrategy, TestExpect,
    };

    fn col(t: &str, c: &str) -> QualifiedColumn {
        QualifiedColumn::new(t, c)
    }

    fn facts() -> ModelFacts {
        ModelFacts {
            measures: BTreeMap::from([
                (
                    "Returns".to_string(),
                    MeasureFacts {
                        fact_table: Some("Sales".into()),
                        unit: None,
                        kpi: None,
                    },
                ),
                (
                    "Churn".to_string(),
                    MeasureFacts {
                        fact_table: Some("Sales".into()),
                        unit: None,
                        kpi: Some(KpiFacts {
                            name: "Churn KPI".into(),
                            target: Some(0.9),
                            // A REAL churn KPI. The thresholds ascend because the
                            // engine's builder refuses any other order; the
                            // STATUSES worsen, which is the only thing in a KPI
                            // that says lower is better.
                            bands: vec![
                                KpiBand::new(0.5, BandStatus::OnTrack),
                                KpiBand::new(0.7, BandStatus::AtRisk),
                                KpiBand::new(0.9, BandStatus::OffTrack),
                            ],
                        }),
                    },
                ),
            ]),
            tables: BTreeMap::from([
                (
                    "Sales".to_string(),
                    TableFacts {
                        kind: None,
                        columns: BTreeSet::from([
                            "InvoiceId".to_string(),
                            "DeptKey".to_string(),
                            "Amount".to_string(),
                        ]),
                        members: BTreeMap::new(),
                        hierarchies: Vec::new(),
                    },
                ),
                (
                    "Dim".to_string(),
                    TableFacts {
                        kind: None,
                        columns: BTreeSet::from(["Dept".to_string(), "DeptKey".to_string()]),
                        members: BTreeMap::from([(
                            "Dept".to_string(),
                            vec!["Refunds".to_string(), "Retail".to_string()],
                        )]),
                        hierarchies: Vec::new(),
                    },
                ),
                (
                    "Far".to_string(),
                    TableFacts {
                        kind: None,
                        columns: BTreeSet::from(["Note".to_string()]),
                        members: BTreeMap::new(),
                        hierarchies: Vec::new(),
                    },
                ),
            ]),
            date_table: None,
            // No calendar at all, so no provenance for one either: the two
            // fields are absent together or present together.
            calendar_source: None,
            relationships: vec![(col("Sales", "DeptKey"), col("Dim", "DeptKey"))],
        }
    }

    /// A document that validates clean: reviewed, roles declared, no rules.
    fn clean_doc() -> StrategyDoc {
        let mut doc = StrategyDoc::default();
        doc.tables.insert(
            "Dim".into(),
            TableStrategy {
                columns: BTreeMap::from([
                    (
                        "Dept".to_string(),
                        ColumnStrategy {
                            role: Role::Analysis,
                            priority: None,
                        },
                    ),
                    (
                        "DeptKey".to_string(),
                        ColumnStrategy {
                            role: Role::Key,
                            priority: None,
                        },
                    ),
                ]),
                reviewed: true,
                ..Default::default()
            },
        );
        doc.tables.insert(
            "Sales".into(),
            TableStrategy {
                columns: BTreeMap::from([(
                    "InvoiceId".to_string(),
                    ColumnStrategy {
                        role: Role::Key,
                        priority: None,
                    },
                )]),
                reviewed: true,
                ..Default::default()
            },
        );
        doc.measures.insert(
            "Returns".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        doc
    }

    fn codes(findings: &[Finding], severity: Severity) -> Vec<&str> {
        findings
            .iter()
            .filter(|f| f.severity == severity)
            .map(|f| f.code.as_str())
            .collect()
    }

    #[test]
    fn a_clean_document_produces_no_errors() {
        let findings = validate(&facts(), &clean_doc());
        assert_eq!(
            codes(&findings, Severity::Error),
            Vec::<&str>::new(),
            "unexpected errors: {findings:?}"
        );
        assert!(!is_refused(&findings));
    }

    #[test]
    fn a_rule_on_a_deleted_measure_is_refused() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Gone".into(),
            scope: Scope::new(),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"unknown-measure"));
        assert!(is_refused(&findings));
    }

    #[test]
    fn a_key_column_cannot_scope_a_rule() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Sales", "InvoiceId"),
                ScopeValue::Members(vec!["INV-1".into()]),
            )]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "scope-column-role")
            .expect("a key column scoping a rule must be refused");
        assert_eq!(f.severity, Severity::Error);
        assert!(f.message.contains("Sales[InvoiceId]"));
    }

    #[test]
    fn an_analysis_dimension_that_is_a_key_is_refused() {
        let mut doc = clean_doc();
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Sales", "InvoiceId"));
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"analysis-dimension-role"));
    }

    #[test]
    fn an_analysis_dimension_that_is_a_label_is_refused_by_role_and_by_the_tables_label_pointer() {
        // A label is what a reader recognises ONE ROW by. Breaking a measure
        // down by it produces one fact per record - true, and useless - so the
        // two roles are mutually exclusive by definition.

        // (a) The ROLE says label.
        let mut by_role = clean_doc();
        by_role.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Label,
                priority: None,
            },
        );
        by_role
            .measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        let f = validate(&facts(), &by_role)
            .into_iter()
            .find(|f| f.code == "analysis-dimension-role")
            .expect("a label-role column must be refused as a breakdown");
        assert_eq!(f.severity, Severity::Error);
        assert!(
            f.message.contains("Dim[Dept]") && f.message.contains("label"),
            "the finding must name the column and the role: {}",
            f.message
        );

        // (b) The table's `labelColumn` POINTER says it, with no per-column role
        // anywhere - the ordinary shape of a hand-written document, and the case
        // the role arm alone could not see.
        let mut by_pointer = clean_doc();
        by_pointer.tables.get_mut("Dim").unwrap().label_column = Some("Dept".into());
        by_pointer.tables.get_mut("Dim").unwrap().columns.remove("Dept");
        by_pointer
            .measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        let f = validate(&facts(), &by_pointer)
            .into_iter()
            .find(|f| f.code == "analysis-dimension-role")
            .expect("the declared labelColumn must be refused as a breakdown");
        assert_eq!(f.severity, Severity::Error);
        assert!(
            f.message.contains("Dim[Dept]") && f.message.contains("label column"),
            "the finding must name the column and say what makes it a label: {}",
            f.message
        );
    }

    #[test]
    fn an_explicit_analysis_role_outranks_the_tables_label_pointer() {
        // THE DELIBERATE NARROWING, and the reason for it. `labelColumn` is
        // written by inference from a NAME HEURISTIC - "does the last word read
        // as 'name'" - while a per-column `role` is a person's statement made
        // with the data in front of them. Refusing a whole document because a
        // heuristic disagrees with a human would be the confident-wrong this
        // layer exists to avoid, and it would refuse the checked-in star fixture,
        // where `Product[Name]` is both the label column and a declared analysis
        // axis over a handful of products.
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().label_column = Some("Dept".into());
        // `Dept` keeps its `role: analysis` from `clean_doc`.
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        assert!(
            !codes(&validate(&facts(), &doc), Severity::Error)
                .contains(&"analysis-dimension-role"),
            "a declared analysis role is a human decision and outranks the pointer"
        );
    }

    #[test]
    fn a_label_column_that_a_hierarchy_names_is_still_a_legitimate_breakdown() {
        // Whoever declared the hierarchy said this column is an axis, and that
        // outranks both spellings of "label" - exactly as it already did for the
        // role on its own.
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().label_column = Some("Dept".into());
        doc.tables.get_mut("Dim").unwrap().columns.remove("Dept");
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        // Without the hierarchy: refused.
        assert!(codes(&validate(&facts(), &doc), Severity::Error)
            .contains(&"analysis-dimension-role"));

        // With one the MODEL declares: accepted.
        let mut with_hierarchy = facts();
        with_hierarchy.tables.get_mut("Dim").unwrap().hierarchies = vec![vec!["Dept".into()]];
        assert!(
            !codes(&validate(&with_hierarchy, &doc), Severity::Error)
                .contains(&"analysis-dimension-role"),
            "a level the model declares is a level"
        );
    }

    #[test]
    fn lower_is_better_on_a_churn_kpi_is_correct_and_is_not_refused() {
        // THE BUG THIS TEST WAS RE-POINTED AT. The Churn fixture's KPI has
        // ASCENDING thresholds - the engine's builder accepts no other order -
        // and WORSENING statuses. A validator that read the thresholds refused
        // this document, which is the one direction a churn measure can have.
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        let findings = validate(&facts(), &doc);
        assert!(
            !codes(&findings, Severity::Error).contains(&"direction-contradicts-kpi"),
            "a churn KPI's own bands agree with lowerIsBetter: {findings:?}"
        );
    }

    #[test]
    fn a_direction_opposite_to_what_the_kpi_bands_say_is_refused_naming_both() {
        // The teeth. Same fixture, and the two ways round to disagree with it:
        // higherIsBetter over a KPI whose statuses worsen upward, and
        // lowerIsBetter over one whose statuses improve upward.
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::HigherIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "direction-contradicts-kpi")
            .expect("the contradiction must be refused");
        assert!(
            f.message.contains("Churn")
                && f.message.contains("higherIsBetter")
                && f.message.contains("lowerIsBetter"),
            "must name the measure, the declared direction and the KPI's: {}",
            f.message
        );
        assert!(
            f.message.contains("Churn KPI") && f.message.contains("0.5:onTrack"),
            "must name the KPI and quote its bands: {}",
            f.message
        );

        // ...and the other way round, on a KPI that really does improve upward.
        let mut ascending = facts();
        ascending.measures.get_mut("Churn").unwrap().kpi = Some(KpiFacts {
            name: "Retention KPI".into(),
            target: Some(0.9),
            bands: vec![
                KpiBand::new(0.5, BandStatus::OffTrack),
                KpiBand::new(0.9, BandStatus::OnTrack),
            ],
        });
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        assert!(codes(&validate(&ascending, &doc), Severity::Error)
            .contains(&"direction-contradicts-kpi"));
    }

    #[test]
    fn a_kpi_that_states_no_ordering_refuses_neither_direction() {
        // One band, so there is no bad-to-good sequence at all. The engine must
        // not manufacture a contradiction out of a KPI that expressed no opinion.
        let mut flat = facts();
        flat.measures.get_mut("Churn").unwrap().kpi = Some(KpiFacts {
            name: "Bare KPI".into(),
            target: Some(0.9),
            bands: vec![KpiBand::new(0.9, BandStatus::OnTrack)],
        });
        for direction in [Direction::LowerIsBetter, Direction::HigherIsBetter] {
            let mut doc = clean_doc();
            doc.measures.insert(
                "Churn".into(),
                MeasureStrategy {
                    direction: Some(direction),
                    reviewed: true,
                    ..Default::default()
                },
            );
            assert!(
                !codes(&validate(&flat, &doc), Severity::Error)
                    .contains(&"direction-contradicts-kpi"),
                "{direction:?} should not be refused by a KPI with one band"
            );
        }
    }

    #[test]
    fn a_literal_target_that_disagrees_with_the_kpis_constant_is_refused_naming_both() {
        // Two definitions of one goal: the KPI badge would say 0.9 and the
        // variance line 0.75, in the same report, with nothing to reconcile them.
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                target: Some(Target::Literal { value: 0.75 }),
                reviewed: true,
                ..Default::default()
            },
        );
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "target-contradicts-kpi")
            .expect("two targets for one measure must be refused");
        assert!(
            f.message.contains("0.75") && f.message.contains("0.9") && f.message.contains("Churn KPI"),
            "must name both numbers and both sources: {}",
            f.message
        );

        // The two ways to be consistent, both of which must pass: inherit the
        // KPI's target, or state the same number.
        for target in [Target::Kpi, Target::Literal { value: 0.9 }] {
            let mut ok = clean_doc();
            ok.measures.insert(
                "Churn".into(),
                MeasureStrategy {
                    direction: Some(Direction::LowerIsBetter),
                    target: Some(target.clone()),
                    reviewed: true,
                    ..Default::default()
                },
            );
            assert!(
                !codes(&validate(&facts(), &ok), Severity::Error)
                    .contains(&"target-contradicts-kpi"),
                "{target:?} agrees with the KPI and must not be refused"
            );
        }
    }

    #[test]
    fn a_by_dimension_key_that_matches_nothing_in_the_model_is_refused() {
        // `is_additive_over` falls back to `default` when no spelling matches, so
        // this typo would leave a lastValue balance ADDITIVE over Dept - and the
        // engine would then claim its share of a total.
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().aggregation = Some(AggregationSpec {
            default: Additivity::Additive,
            by_dimension: BTreeMap::from([("Dpet".to_string(), Additivity::LastValue)]),
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "unknown-aggregation-dimension")
            .expect("an unmatched byDimension key must be refused");
        assert!(f.message.contains("Dpet"), "{}", f.message);
        assert!(
            f.message.contains("Table[Column]"),
            "the message must name the valid spellings: {}",
            f.message
        );
    }

    #[test]
    fn all_three_spellings_of_a_by_dimension_key_are_accepted() {
        // Exactly the three `is_additive_over` tries. Accepting fewer would refuse
        // a document the resolver honours; accepting more would bless a key it
        // silently ignores.
        for key in ["Dim[Dept]", "Dept", "Dim"] {
            let mut doc = clean_doc();
            doc.measures.get_mut("Returns").unwrap().aggregation = Some(AggregationSpec {
                default: Additivity::Additive,
                by_dimension: BTreeMap::from([(key.to_string(), Additivity::LastValue)]),
            });
            assert!(
                !codes(&validate(&facts(), &doc), Severity::Error)
                    .contains(&"unknown-aggregation-dimension"),
                "'{key}' is a spelling the resolver matches and must be accepted"
            );
        }
    }

    #[test]
    fn a_rules_own_by_dimension_typo_is_refused_too() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                aggregation: Some(AggregationSpec {
                    default: Additivity::Additive,
                    by_dimension: BTreeMap::from([("Nope".to_string(), Additivity::LastValue)]),
                }),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "unknown-aggregation-dimension")
            .expect("a rule's aggregation is as unvalidated as a measure's was");
        assert_eq!(f.path, "rules[0].set.aggregation");
    }

    #[test]
    fn a_model_hierarchy_lets_a_label_column_scope_even_with_no_hierarchy_in_the_document() {
        // The document declares Dept as a LABEL and declares no hierarchies at
        // all - the ordinary state of a hand-written file, or of one written
        // before somebody added the hierarchy to the model. Before the facts
        // carried the model's hierarchies, this was refused.
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Label,
                priority: None,
            },
        );
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                materiality: Some(Materiality::Absolute { value: 1.0 }),
                ..Default::default()
            },
            note: None,
        });

        // Without the model hierarchy: refused, exactly as before.
        assert!(codes(&validate(&facts(), &doc), Severity::Error).contains(&"scope-column-role"));

        // With it: accepted, and nothing else changed.
        let mut with_hierarchy = facts();
        with_hierarchy.tables.get_mut("Dim").unwrap().hierarchies = vec![vec!["Dept".into()]];
        assert!(
            !codes(&validate(&with_hierarchy, &doc), Severity::Error)
                .contains(&"scope-column-role"),
            "a level the MODEL declares is a level"
        );
    }

    #[test]
    fn adding_the_models_hierarchies_can_only_remove_errors_and_never_add_one() {
        // The loosening claim, tested rather than asserted: for every document
        // below, the errors seen WITH the model's hierarchies must be a subset of
        // the errors seen without them.
        let mut labelled = clean_doc();
        labelled.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Label,
                priority: None,
            },
        );
        let mut scoped = labelled.clone();
        scoped.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let mut analysed = labelled.clone();
        analysed
            .measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        let mut keyed = clean_doc();
        keyed.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Sales", "InvoiceId"),
                ScopeValue::Members(vec!["INV-1".into()]),
            )]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });

        let mut with_hierarchy = facts();
        with_hierarchy.tables.get_mut("Dim").unwrap().hierarchies = vec![vec!["Dept".into()]];

        for (label, doc) in [
            ("clean", clean_doc()),
            ("label-scoped", scoped),
            ("label-analysed", analysed),
            // A key column is in NO hierarchy, so its refusal must survive - or
            // "loosening only" would have quietly become "loosening everything".
            ("key-scoped", keyed),
        ] {
            let before: BTreeSet<String> = validate(&facts(), &doc)
                .iter()
                .filter(|f| f.severity == Severity::Error)
                .map(|f| format!("{}@{}", f.code, f.path))
                .collect();
            let after: BTreeSet<String> = validate(&with_hierarchy, &doc)
                .iter()
                .filter(|f| f.severity == Severity::Error)
                .map(|f| format!("{}@{}", f.code, f.path))
                .collect();
            assert!(
                after.is_subset(&before),
                "'{label}' gained errors when the model's hierarchies became visible: {:?}",
                after.difference(&before).collect::<Vec<_>>()
            );
        }
        assert!(
            codes(&validate(&with_hierarchy, &clean_doc()), Severity::Error).is_empty(),
            "the clean document stays clean"
        );
    }

    #[test]
    fn duplicate_rule_ids_are_refused() {
        let mut doc = clean_doc();
        for scope in [
            Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Retail".into()]))]),
        ] {
            doc.rules.push(Rule {
                id: "same".into(),
                measure: "Returns".into(),
                scope,
                set: AttributeSet {
                    materiality: Some(Materiality::Absolute { value: 1.0 }),
                    ..Default::default()
                },
                note: None,
            });
        }
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"duplicate-rule-id"));
    }

    #[test]
    fn an_overlap_conflict_refuses_the_document() {
        let mut doc = clean_doc();
        doc.tables.get_mut("Sales").unwrap().columns.insert(
            "Amount".into(),
            ColumnStrategy {
                role: Role::Analysis,
                priority: None,
            },
        );
        doc.rules.push(Rule {
            id: "a".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        doc.rules.push(Rule {
            id: "b".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Sales", "Amount"), ScopeValue::Members(vec!["big".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::LowerIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "rule-overlap")
            .expect("the overlap must reach the validator, not just the checker");
        assert!(
            f.message.contains("'a'") && f.message.contains("'b'"),
            "the finding must name both rules: {}",
            f.message
        );
    }

    #[test]
    fn a_malformed_date_bound_is_refused_because_overlap_compares_bounds_as_text() {
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Analysis,
                priority: None,
            },
        );
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::between("1/4/2025", "2025-06-30"),
            )]),
            set: AttributeSet {
                cadence: Some(Cadence::Monthly),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"malformed-date-range"));
    }

    #[test]
    fn an_orphan_entry_and_an_unreviewed_entry_warn_but_do_not_refuse() {
        let mut doc = clean_doc();
        doc.measures.insert(
            "Deleted".into(),
            MeasureStrategy {
                reviewed: true,
                ..Default::default()
            },
        );
        doc.measures.get_mut("Returns").unwrap().reviewed = false;
        let findings = validate(&facts(), &doc);
        assert!(!is_refused(&findings), "these are staleness, not lies: {findings:?}");
        let warns = codes(&findings, Severity::Warning);
        assert!(warns.contains(&"orphan-measure"));
        assert!(warns.contains(&"unreviewed"));
    }

    #[test]
    fn a_never_slice_by_column_no_relationship_reaches_warns() {
        let mut doc = clean_doc();
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .never_slice_by
            .push(col("Far", "Note"));
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Warning).contains(&"unreachable-never-slice-by"));
        assert!(!is_refused(&findings));
    }

    #[test]
    fn a_member_the_model_no_longer_has_warns() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Wholesale".into()]),
            )]),
            set: AttributeSet {
                materiality: Some(Materiality::Absolute { value: 1.0 }),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Warning).contains(&"unknown-member"));
        assert!(!is_refused(&findings));
    }

    #[test]
    fn a_document_over_the_extension_data_cap_is_refused() {
        let mut doc = clean_doc();
        doc.periods.push(PeriodAnnotation {
            id: "big".into(),
            measure: None,
            scope: Scope::new(),
            note: "x".repeat(MAX_STRATEGY_DOC_BYTES + 1),
        });
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"document-too-large"));
    }

    // --- the inline test runner ---------------------------------------------

    fn doc_with_refunds_rule() -> StrategyDoc {
        let mut doc = clean_doc();
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
    fn a_consultants_passing_assertion_produces_no_finding() {
        let mut doc = doc_with_refunds_rule();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Refunds".into()]),
            )]),
            given: TestGiven {
                delta: 5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: Some("refunds-dept".into()),
            },
        });
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
        assert!(!is_refused(&validate(&facts(), &doc)));
    }

    #[test]
    fn a_consultants_failing_assertion_refuses_the_document() {
        let mut doc = doc_with_refunds_rule();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Refunds".into()]),
            )]),
            given: TestGiven {
                delta: 5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Unfavourable,
                decided_by: None,
            },
        });
        let findings = run_inline_tests(&facts(), &doc);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "inline-test-failed");
        assert!(findings[0].message.contains("unfavourable"));
        assert!(is_refused(&validate(&facts(), &doc)));
    }

    #[test]
    fn an_assertion_that_is_right_for_the_wrong_reason_still_fails() {
        // The status matches, but a different rule (none at all) decided it. This
        // is the case a status-only assertion would wave through.
        let mut doc = doc_with_refunds_rule();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Retail".into()]))]),
            given: TestGiven {
                delta: -5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: Some("refunds-dept".into()),
            },
        });
        let findings = run_inline_tests(&facts(), &doc);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert!(
            findings[0].message.contains("decided by no rule at all"),
            "{}",
            findings[0].message
        );
    }

    #[test]
    fn an_aggregate_spanning_two_directions_is_reported_as_suppressed_to_the_test_runner() {
        let mut doc = doc_with_refunds_rule();
        // No scope: the fact rolls up Refunds and Retail, which disagree.
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: 5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Suppressed,
                decided_by: Some("refunds-dept".into()),
            },
        });
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
    }

    #[test]
    fn a_movement_below_absolute_materiality_is_neutral() {
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Absolute { value: 1000.0 });
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: -10.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Neutral,
                decided_by: None,
            },
        });
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
    }

    #[test]
    fn a_test_naming_a_rule_that_does_not_exist_is_refused() {
        let mut doc = clean_doc();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: -1.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: Some("no-such-rule".into()),
            },
        });
        assert!(codes(&validate(&facts(), &doc), Severity::Error).contains(&"unknown-rule"));
    }

    #[test]
    fn iso_dates_are_recognised_and_anything_else_is_not() {
        assert!(is_iso_date("2025-01-31"));
        assert!(is_iso_date("2025-12-01"));
        for bad in ["2025-1-31", "2025/01/31", "31-01-2025", "2025-13-01", "2025-01-00", ""] {
            assert!(!is_iso_date(bad), "'{bad}' should not be accepted");
        }
    }
}
