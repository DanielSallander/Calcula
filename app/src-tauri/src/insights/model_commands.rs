//! FILENAME: app/src-tauri/src/insights/model_commands.rs
// PURPOSE: The two model-aware entry points: analyse a semantic model into
//          facts, and write those facts down on a new sheet.
// CONTEXT: This file owns the QUERIES and nothing else. Every judgement — what
//          is material, which way is good, whether a share may be claimed —
//          lives in `model.rs` over hand-buildable inputs, so the arithmetic is
//          tested in milliseconds and this file's own bugs can only ever be
//          about talking to the engine.
//
//          THE PLAN IS BOUNDED, NOT MERELY CORRECT. Queries on one connection
//          SERIALISE behind the engine's mutex, so an analysis that issues one
//          query per measure per dimension per period would lock the model for
//          the length of a coffee break and look like a hang. The budget is:
//          one series query per measure (which carries the measure AND its
//          definitional operands AND its target measure, so the decomposition
//          costs nothing extra), plus one query per analysis dimension, all
//          under a hard ceiling of `MAX_QUERIES_PER_RUN`. What the ceiling cut
//          is REPORTED in `notes`.
//
//          RLS IS NOT OPTIONAL AND NOT INHERITED. `apply_connection_role` runs
//          inside the engine lock immediately before every query, exactly as
//          `bi_query_core` does. The active role is STICKY engine state and
//          connections that share a model share one engine, so a query that
//          skips it reads the rows of whichever colleague queried last.

use serde::{Deserialize, Serialize};
use tauri::State;

use engine::LocaleSettings;

use crate::bi::commands::{apply_connection_role, batches_to_result, get_engine_arc};
use crate::bi::types::{BiState, ConnectionId};
use crate::persistence::FileState;
use crate::AppState;

use super::model::{
    self, DimensionSlice, DriverInput, DriverShape, DriverTerm, MeasureObservation, MemberSeries,
    ModelRun, StatusBand, MAX_PERIODS,
};
use super::report::{self, ReportGrid, REPORT_SHEET_BASE_NAME};
// `facts_with_authored_kinds` is reached through the module rather than the
// `strategy::` re-export list: the re-exports live in a `mod.rs`, and the seam
// this needs is one function rather than a new public surface.
use super::strategy::facts::{facts_with_authored_kinds, AuthoredKinds, KindRefusal};
use super::strategy::types::{is_readable_doc_version, STRATEGY_DOC_VERSION};
use super::strategy::{resolve, ModelFacts, QualifiedColumn, ScopePoint, StrategyDoc, Target};
use super::wire::WireBundle;

/// The hard ceiling on engine round-trips for one analysis.
///
/// 12 measures x (1 series + 4 dimensions) is 60; this stops well short of that
/// and says so, because a bound nobody can feel is a bound that will be raised
/// silently the first time somebody wants one more section.
pub const MAX_QUERIES_PER_RUN: usize = 40;

/// What the frontend asks for. Mirrors `ModelInsightsRequest` in
/// `app/src/api/insightsService.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInsightsRequest {
    pub connection_id: ConnectionId,
    /// Empty means "the measures the strategy layer ranks highest".
    #[serde(default)]
    pub measures: Vec<String>,
}

/// Where the report landed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSheetResponse {
    pub sheet_name: String,
    pub sheet_index: usize,
    pub row_count: usize,
    pub col_count: usize,
    /// The same text the pane shows, so a caller that asked for a sheet can
    /// still paste the summary somewhere else without asking twice.
    pub markdown: String,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Reading the model
// ---------------------------------------------------------------------------

fn kpi_status_word(status: bi_engine::KpiStatus) -> &'static str {
    match status {
        bi_engine::KpiStatus::OffTrack => "Off track",
        bi_engine::KpiStatus::AtRisk => "At risk",
        bi_engine::KpiStatus::OnTrack => "On track",
    }
}

/// The strategy document as stored, or an empty one.
///
/// An ABSENT document is the normal state of a model nobody has annotated, and
/// it means every attribute resolves from its base layer. An UNREADABLE one is
/// a different thing entirely and is reported: the write path validates before
/// storing, so a document that will not parse means something else wrote it.
fn strategy_doc(model: &bi_engine::DataModel, notes: &mut Vec<String>) -> StrategyDoc {
    let Some(raw) = model
        .extension_data()
        .get(crate::bi::model_editor::STRATEGY_EXTENSION_KEY)
    else {
        return StrategyDoc::default();
    };
    if raw.is_null() {
        return StrategyDoc::default();
    }
    match serde_json::from_value::<StrategyDoc>(raw.clone()) {
        // A VERSION THIS BUILD DOES NOT UNDERSTAND IS NOT A DOCUMENT IT MAY
        // APPLY. `validate.rs` refuses one at the write gates with an anchored
        // finding, but this path parses WITHOUT validating - so a `.calp` or
        // `.cala` written by a newer build reached the planner and every rule,
        // direction and materiality in it was read with v1 meaning, in silence.
        // The `.cala` reader already takes this line for the workbook format:
        // refuse a higher version rather than half-understand it.
        //
        // Falling back to the empty document is the safe half. The report then
        // says only what the MODEL declares, which is less than the author
        // wanted but never something they did not write.
        Ok(doc) if !is_readable_doc_version(doc.version) => {
            notes.push(format!(
                "The model's strategy document declares version {} and this build understands \
                 version {}; it was not applied. Every attribute fell back to what the model \
                 itself declares. Open it in a build that understands it, or re-save it here.",
                doc.version, STRATEGY_DOC_VERSION
            ));
            StrategyDoc::default()
        }
        Ok(doc) => doc,
        Err(e) => {
            notes.push(format!(
                "The model's strategy document could not be read ({e}); every attribute fell back \
                 to what the model itself declares."
            ));
            StrategyDoc::default()
        }
    }
}

/// Candidate time-axis columns of the calendar, best first.
///
/// A column the model tagged `DateKey` is the model author's own answer. Failing
/// that, the first `Date`/`Timestamp`-typed column in declaration order — which
/// is a guess, but a guess about which column holds dates, not about what
/// "good" means.
///
/// THE CALENDAR COMES FROM `facts`, NOT FROM `model.date_table()` DIRECTLY.
/// Most models never call `mark_date_table`, and reading the declaration alone
/// returned an empty candidate list for every one of them — so a model with no
/// strategy document got no time axis at all, and the entire time-series half of
/// the engine went quiet with nothing said. `facts.date_table` is the
/// declaration falling back to an INFERRED calendar, and `plan_time_axis` emits
/// a note whenever the one it used was inferred. The guess is allowed precisely
/// because it announces itself.
fn date_axis_candidates(
    model: &bi_engine::DataModel,
    facts: &ModelFacts,
) -> Vec<QualifiedColumn> {
    let Some(table_name) = facts.date_table.as_deref() else {
        return Vec::new();
    };
    let Ok(table) = model.table(table_name) else {
        return Vec::new();
    };
    let mut out: Vec<QualifiedColumn> = Vec::new();
    for column in table.columns() {
        if column.date_role() == Some(bi_engine::DateRole::DateKey) {
            out.push(QualifiedColumn::new(table_name, column.name()));
        }
    }
    for column in table.columns() {
        if matches!(
            column.data_type(),
            bi_engine::DataType::Date | bi_engine::DataType::Timestamp
        ) {
            let candidate = QualifiedColumn::new(table_name, column.name());
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// The measure's definitional shape, read from the model's own ASTs.
fn shape_of(model: &bi_engine::DataModel, measure: &str) -> Option<DriverShape> {
    let m = model.measure(measure).ok()?;
    let lookup = |name: &str| model.measure(name).ok().map(|m| m.expression().clone());
    model::driver_shape(m.expression(), &lookup)
}

/// What the run owes a reader about a table kind the document states and the
/// model disproves.
///
/// A SAVED DOCUMENT CAN BE INVALIDATED WITHOUT BEING EDITED. `validate.rs` runs
/// at the two write gates, so a document that was valid when it was stored is
/// never re-judged; delete the relationship that made `Product` a lookup, and
/// the next run silently stops applying `kind: "dimension"` — the same class of
/// silence as an unreadable strategy document, which this file has always had a
/// note for. The report says something different and nothing says why.
///
/// It names the table, what was authored, and WHAT THE TOPOLOGY SAYS INSTEAD,
/// because "your kind was ignored" sends a reader to a dropdown that already
/// shows the value they typed. `facts` is the built facts, so `derived` is the
/// kind the run actually used.
fn kind_conflict_notes(facts: &ModelFacts, authored: &AuthoredKinds) -> Vec<String> {
    let mut out = Vec::new();
    // THE DEMOTION THAT TOOK EFFECT, said first because it is the largest thing
    // this document did. Nothing refused it, so it produces no conflict and
    // would otherwise reach the reader as an absence: a report that silently
    // stopped reporting trends.
    if let Some(demoted) = &authored.demoted_guess {
        out.push(format!(
            "The strategy document calls '{demoted}' a '{}', and that was the only table this \
             model could have run time along. It now has no time axis, so no trend, change point \
             or seasonality is reported for any measure. Call '{demoted}' a 'calendar' in the \
             Strategy tab, or mark a date table in the Model Editor.",
            authored
                .accepted
                .get(demoted)
                .map(|k| k.label())
                .unwrap_or("dimension"),
        ));
    }
    for conflict in &authored.conflicts {
        let table = &conflict.table;
        let kind = conflict.authored.label();
        let derived = facts
            .tables
            .get(table)
            .and_then(|t| t.kind)
            .map(|k| k.label())
            .unwrap_or("unclassified");
        out.push(match &conflict.refusal {
            KindRefusal::NothingLooksItUp { filters } => {
                let topology = match filters {
                    Some(other) => format!(
                        "filters flow OUT of it to '{other}', so the model cannot look it up — it \
                         is the grain"
                    ),
                    None => "no active many-to-one or one-to-one relationship points at it, so \
                             the model cannot look it up"
                        .to_string(),
                };
                format!(
                    "The strategy document calls '{table}' a '{kind}', and the model's \
                     relationships disprove it: {topology}. That kind was not applied — this \
                     report treated '{table}' as a '{derived}'. Change the kind in the Strategy \
                     tab, or add the relationship that would make it true."
                )
            }
            KindRefusal::AmbiguousCalendar { other } => format!(
                "The strategy document calls both '{table}' and '{other}' a 'calendar', so \
                 neither was used: this report treated '{table}' as a '{derived}'. Which table \
                 time runs along is one decision; make it in the Strategy tab, and give the other \
                 one a different kind."
            ),
            // SAID OUT LOUD BECAUSE THE CONSEQUENCE IS NOT GUESSABLE FROM THE
            // CONTROL. Taking the calendar away removes every trend, change
            // point and seasonality claim in the report at once, and a dropdown
            // gives no hint of that — so the one case where the model's own
            // declaration saves the reader from it is worth a sentence.
            KindRefusal::TheModelDeclaresItTheDateTable => format!(
                "The strategy document calls '{table}' a '{kind}', but the model itself marks it \
                 as the date table, so it was left as the calendar. Demoting it would have taken \
                 the time axis away and with it every trend, change point and seasonality claim \
                 in this report. If that is what you meant, unmark the date table in the Model \
                 Editor first."
            ),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

/// One row of a query result, reduced to the two things the planner reads.
struct QueryGrid {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
}

impl QueryGrid {
    /// The result column holding `measure`.
    ///
    /// By NAME first: the engine names a value column after its measure, and a
    /// name match survives the planner adding a column. Positional fallback for
    /// the case where it does not, because reading the wrong column silently
    /// reports one measure's numbers under another measure's name.
    fn measure_column(&self, measure: &str, group_by_count: usize, ordinal: usize) -> Option<usize> {
        if let Some(i) = self.columns.iter().position(|c| c == measure) {
            return Some(i);
        }
        let positional = group_by_count + ordinal;
        (positional < self.columns.len()).then_some(positional)
    }

    fn number(&self, row: usize, col: usize) -> Option<f64> {
        self.rows
            .get(row)?
            .get(col)?
            .as_ref()
            .and_then(|s| s.parse::<f64>().ok())
    }

    fn text(&self, row: usize, col: usize) -> String {
        self.rows
            .get(row)
            .and_then(|r| r.get(col))
            .and_then(|v| v.clone())
            .unwrap_or_default()
    }
}

/// Run one query the way every other structured surface runs one.
///
/// The shape is `bi_query_core`'s, deliberately: engine Arc out of the
/// connections mutex, lock the engine, apply the connection's RLS role INSIDE
/// that lock, then query. Any other order is a hole.
async fn run_query(
    bi_state: &BiState,
    connection_id: ConnectionId,
    request: bi_engine::QueryRequest,
) -> Result<QueryGrid, String> {
    let engine_arc = get_engine_arc(bi_state, connection_id.clone())?;
    let batches = {
        let mut engine = engine_arc.lock().await;
        apply_connection_role(&mut engine, bi_state, connection_id.clone());
        // The second half is the list of tables auto-refresh actually pulled.
        // Insights reads it for nothing: a stale table is the engine's own
        // report to make, and `bi_query_core` already logs it for every query.
        let (batches, _refreshed) = engine
            .query_auto_refresh(request)
            .await
            .map_err(|e| crate::bi::commands::friendly_bi_query_error("Insights query failed", &e))?;
        batches
    };
    let result = batches_to_result(&batches);
    Ok(QueryGrid {
        columns: result.columns,
        rows: result.rows,
    })
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/// Analyse one connection's model. READ-ONLY: it takes no `FileState` and
/// constructs no `DocumentEffect`, because it changes nothing that is saved.
pub async fn run_model_insights(
    bi_state: &BiState,
    locale: &LocaleSettings,
    request: &ModelInsightsRequest,
) -> Result<ModelRun, String> {
    let (base, model_label) = {
        let connections = bi_state
            .connections
            .lock()
            .map_err(|e| format!("connections lock poisoned: {e}"))?;
        let conn = connections
            .get(&request.connection_id)
            .ok_or("Connection not found")?;
        let model = conn
            .base_model
            .clone()
            .ok_or("This connection has no model loaded")?;
        // The connection's own name is what the user called this model. A
        // generic "Model" heading on a report sheet tells a later reader
        // nothing about which of three connections produced it.
        let label = if conn.name.trim().is_empty() {
            "Model".to_string()
        } else {
            conn.name.clone()
        };
        (model, label)
    };

    let mut notes: Vec<String> = Vec::new();
    let doc = strategy_doc(&base, &mut notes);
    // WITH THE DOCUMENT, because this is the run. A person who corrected the
    // table kind in the Strategy tab — the commonest correction being "that
    // table is the calendar and you missed it" — expects the report to follow,
    // and the whole cascade below (`date_axis_candidates`, `plan_time_axis`, the
    // series query, every trend and seasonality claim) hangs off
    // `facts.date_table`. The DRAFT path deliberately does not do this: see
    // `facts_from_model`.
    //
    // THE VERDICT COMES BACK WITH THE FACTS. Building them already judged every
    // authored kind; taking the pair is what lets the refusals be REPORTED
    // without a second pass over `doc.tables`.
    let (facts, authored_kinds): (ModelFacts, AuthoredKinds) =
        facts_with_authored_kinds(&base, &doc);
    notes.extend(kind_conflict_notes(&facts, &authored_kinds));

    // TAKE THE PLAN, NOT JUST THE ANSWER. `plan_time_axis` returns the axis AND
    // the note it owes the reader — that the calendar was GUESSED, when nobody
    // marked one. Reading `plan_time_axis(...).axis` and discarding the notes
    // would drop that and let a guessed calendar carry every trend, change point
    // and seasonality claim in the report without saying so, which is the same
    // honest-but-invisible failure `plan_dimensions` already has a note for two
    // calls below.
    let axis_plan = model::plan_time_axis(&doc, &facts, &date_axis_candidates(&base, &facts));
    notes.extend(axis_plan.notes);
    let axis = axis_plan.axis;
    if axis.is_none() {
        notes.push(
            "This model has no time axis: neither the strategy document's defaultTimeAxis nor a \
             marked date table with a date column. Nothing below is ordered in time, so no trend, \
             change or seasonality is reported."
                .to_string(),
        );
    }

    let chosen = model::choose_measures(&doc, &facts, &request.measures);
    if chosen.is_empty() {
        notes.push("This model declares no measures to analyse.".to_string());
    }

    // CONFIRMATION IS ADVISORY, AND THE REPORT HAS TO SAY SO.
    //
    // `resolve` has no `reviewed` gate: an INFERRED direction, materiality or
    // aggregation is applied at full strength whether or not a person ever
    // looked at it. That is the right design — an inferred draft has to stay
    // savable, which is the real reason the `unreviewed` finding is a warning
    // and not an error — but the Strategy tab's Confirm workflow reads as
    // though confirming CHANGES something, and it does not. Nowhere else does
    // the reader learn that a word like "worse" rests on a guess nobody
    // endorsed.
    //
    // Counted over the measures ACTUALLY IN THIS RUN, not the whole document: an
    // unreviewed entry for a measure nothing reported is not something this
    // report rests on.
    let unreviewed: Vec<&str> = chosen
        .iter()
        .filter(|m| doc.measures.get(m.as_str()).is_some_and(|e| !e.reviewed))
        .map(|m| m.as_str())
        .collect();
    if !unreviewed.is_empty() {
        notes.push(format!(
            "{} of the {} measures below still carry inferred settings nobody has confirmed ({}). \
             The engine applies them at full strength either way — confirming in the Strategy tab \
             records that a person agreed, it does not change what is reported. Where a direction \
             was guessed wrong, the word 'better' or 'worse' is guessed wrong with it.",
            unreviewed.len(),
            chosen.len(),
            unreviewed.join(", ")
        ));
    }

    // KPI bands, indexed by the measure they mark up.
    //
    // THE REASON TO READ THEM AGAIN IS THE SPELLING, NOT THE CONTENT, and this
    // comment used to say `facts_from_model` keeps only the thresholds. It does
    // not: `KpiFacts::bands` carries the STATUS across with each threshold,
    // under a capitalised comment in facts.rs saying why - thresholds alone
    // could only ever conclude "higher is better", including for a churn KPI
    // whose every band says the opposite. What differs is the word. The
    // resolver's `BandStatus` prints WIRE spellings for a validation message to
    // quote (`offTrack`), and a report cell needs the DISPLAY words a person
    // reads ("Off track"), which is what is built here.
    //
    // Reusing the resolver's copy would put `offTrack` in the Status column of a
    // shipped report, so the model is read a second time rather than the wire
    // word being prettified back into a display one.
    let mut bands_by_measure: std::collections::BTreeMap<String, Vec<StatusBand>> =
        std::collections::BTreeMap::new();
    for kpi in base.kpis() {
        bands_by_measure.insert(
            kpi.base_measure().to_string(),
            kpi.status_bands()
                .iter()
                .map(|b| StatusBand {
                    threshold: b.threshold,
                    status: kpi_status_word(b.status).to_string(),
                })
                .collect(),
        );
    }

    let mut queries_used = 0usize;
    let mut per_measure = Vec::new();

    for measure in &chosen {
        let point = ScopePoint::default();
        let resolved = resolve(&facts, &doc, measure, &point);
        let fact_table = facts
            .measures
            .get(measure)
            .and_then(|m| m.fact_table.clone());

        let plan = model::plan_dimensions(&resolved, &facts, fact_table.as_deref());
        notes.extend(plan.notes.clone());

        let shape = shape_of(&base, measure);
        let operands = shape.as_ref().map(DriverShape::operands).unwrap_or_default();
        // A measure-valued target is a number only once a query has run — so it
        // rides along in the SAME query rather than costing one of its own.
        let target_measure = match resolved.target.as_ref().map(|t| &t.value) {
            Some(Target::Measure { r#ref }) => Some(r#ref.clone()),
            _ => None,
        };

        let mut measures: Vec<String> = vec![measure.clone()];
        for extra in operands.iter().chain(target_measure.iter()) {
            if !measures.contains(extra) {
                measures.push(extra.clone());
            }
        }

        let mut observation = MeasureObservation {
            measure: measure.clone(),
            format_string: base
                .measure(measure)
                .ok()
                .and_then(|m| m.format_string().map(|s| s.to_string())),
            bands: bands_by_measure.get(measure).cloned().unwrap_or_default(),
            ..MeasureObservation::default()
        };

        if queries_used >= MAX_QUERIES_PER_RUN {
            notes.push(format!(
                "{measure} was not queried: this run reached its ceiling of \
                 {MAX_QUERIES_PER_RUN} queries."
            ));
            continue;
        }

        // --- the series (or, with no axis, one scalar point) -----------------
        let series_request = match axis.as_ref() {
            Some(a) => bi_engine::QueryRequest {
                measures: measures.clone(),
                group_by: vec![bi_engine::ColumnRef::new(&a.table, &a.column)],
                // DESCENDING then reversed: `limit` applies after ordering, so
                // ascending would hand back the OLDEST periods and report last
                // year's movement as this month's.
                order_by: vec![bi_engine::OrderByClause::column_desc(&a.table, &a.column)],
                limit: Some(MAX_PERIODS),
                ..Default::default()
            },
            None => bi_engine::QueryRequest {
                measures: measures.clone(),
                ..Default::default()
            },
        };
        let grid = run_query(bi_state, request.connection_id.clone(), series_request).await?;
        queries_used += 1;

        let group_by_count = usize::from(axis.is_some());
        let value_col = grid
            .measure_column(measure, group_by_count, 0)
            .ok_or_else(|| format!("The query for {measure} returned no value column"))?;

        let mut labels: Vec<String> = Vec::new();
        let mut values: Vec<f64> = Vec::new();
        for row in 0..grid.rows.len() {
            let Some(value) = grid.number(row, value_col) else {
                continue;
            };
            labels.push(if group_by_count == 1 {
                grid.text(row, 0)
            } else {
                "all periods".to_string()
            });
            values.push(value);
        }
        if axis.is_some() {
            // The query came back newest first.
            labels.reverse();
            values.reverse();
        }
        observation.labels = labels;
        observation.values = values;

        // --- the target ------------------------------------------------------
        observation.target_value = match resolved.target.as_ref().map(|t| &t.value) {
            Some(Target::Literal { value }) => Some(*value),
            Some(Target::Measure { r#ref }) => measures
                .iter()
                .position(|m| m == r#ref)
                .and_then(|ordinal| grid.measure_column(r#ref, group_by_count, ordinal))
                .and_then(|col| grid.number(grid.rows.len().saturating_sub(1), col)),
            // A band has no single number to be over or under; the direction
            // `targetBand` is what reads it, and v1 does not emit a variance
            // against a band rather than emitting a wrong one.
            Some(Target::Band { .. }) | Some(Target::Kpi) | None => None,
        };

        // --- the definitional operands, from the same query ------------------
        if let (Some(shape), true) = (shape.as_ref(), observation.values.len() >= 2) {
            // `grid` is still in QUERY order — newest first — while
            // `observation` has been reversed. Row 0 is therefore the LATEST
            // period and row 1 the one before it, which are exactly the two the
            // change fact compares. Reading them the other way round would
            // report every driver with its sign inverted.
            let read = |name: &str| -> Option<(f64, f64)> {
                let ordinal = measures.iter().position(|m| m == name)?;
                let col = grid.measure_column(name, group_by_count, ordinal)?;
                Some((grid.number(1, col)?, grid.number(0, col)?))
            };
            observation.driver = match shape {
                DriverShape::Sum(terms) => {
                    let mut measured: Vec<DriverTerm> = Vec::new();
                    let mut complete = true;
                    for (name, sign) in terms {
                        match read(name) {
                            Some((first, last)) => measured.push(DriverTerm {
                                measure: name.clone(),
                                coefficient: *sign as f64,
                                first,
                                last,
                            }),
                            // A term with no measured movement would make the
                            // residual carry it silently. Refuse the whole
                            // decomposition instead.
                            None => complete = false,
                        }
                    }
                    (complete && !measured.is_empty())
                        .then_some(DriverInput::Sum { terms: measured })
                }
                DriverShape::Ratio {
                    numerator,
                    denominator,
                } => match (read(numerator), read(denominator)) {
                    (Some((n_first, n_last)), Some((d_first, d_last))) => {
                        Some(DriverInput::Ratio {
                            numerator: numerator.clone(),
                            denominator: denominator.clone(),
                            n_first,
                            n_last,
                            d_first,
                            d_last,
                        })
                    }
                    _ => None,
                },
            };
        }

        // --- one query per analysis dimension --------------------------------
        let periods: Option<(String, String)> = {
            let n = observation.labels.len();
            (n >= 2).then(|| {
                (
                    observation.labels[n - 2].clone(),
                    observation.labels[n - 1].clone(),
                )
            })
        };
        if let (Some(a), Some((prior, latest))) = (axis.as_ref(), periods.clone()) {
            for dimension in &plan.dimensions {
                if queries_used >= MAX_QUERIES_PER_RUN {
                    notes.push(format!(
                        "{measure} was not sliced by {dimension}: this run reached its ceiling of \
                         {MAX_QUERIES_PER_RUN} queries."
                    ));
                    break;
                }
                let slice_request = bi_engine::QueryRequest {
                    measures: vec![measure.clone()],
                    group_by: vec![
                        bi_engine::ColumnRef::new(&dimension.table, &dimension.column),
                        bi_engine::ColumnRef::new(&a.table, &a.column),
                    ],
                    // Both compared periods in ONE query. Two queries would be
                    // two RLS applications and two refresh windows, and a
                    // member could move between them.
                    scoped_in_filters: vec![bi_engine::ScopedInFilter {
                        table: Some(a.table.clone()),
                        filter: bi_engine::InFilter::new(
                            a.column.clone(),
                            vec![prior.clone(), latest.clone()],
                        ),
                        level: 1,
                    }],
                    ..Default::default()
                };
                let slice_grid =
                    match run_query(bi_state, request.connection_id.clone(), slice_request).await {
                        Ok(g) => g,
                        Err(e) => {
                            // One dimension the engine refused must not lose the
                            // whole analysis — but it must be SAID.
                            notes.push(format!(
                                "{measure} could not be sliced by {dimension}: {e}"
                            ));
                            queries_used += 1;
                            continue;
                        }
                    };
                queries_used += 1;

                let Some(value_col) = slice_grid.measure_column(measure, 2, 0) else {
                    continue;
                };
                let mut members: std::collections::BTreeMap<String, MemberSeries> =
                    std::collections::BTreeMap::new();
                for row in 0..slice_grid.rows.len() {
                    let member = slice_grid.text(row, 0);
                    let period = slice_grid.text(row, 1);
                    let Some(value) = slice_grid.number(row, value_col) else {
                        continue;
                    };
                    let entry = members.entry(member.clone()).or_insert(MemberSeries {
                        member,
                        first: None,
                        last: None,
                    });
                    if period == prior {
                        entry.first = Some(value);
                    } else if period == latest {
                        entry.last = Some(value);
                    }
                }
                if members.is_empty() {
                    continue;
                }
                observation.slices.push(DimensionSlice {
                    dimension: dimension.clone(),
                    members: members.into_values().collect(),
                });
            }
        }

        per_measure.push(model::facts_for_measure(&observation, &resolved, locale));
    }

    Ok(model::build_run(&model_label, locale, per_measure, notes))
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// Facts about MEASURES, with declared direction, additivity and materiality.
///
/// READ-ONLY. It constructs no `DocumentEffect` because it changes nothing that
/// is saved: it reads the model, asks the engine, and returns sentences.
#[tauri::command]
pub async fn insights_analyze_model(
    bi_state: State<'_, BiState>,
    app_state: State<'_, AppState>,
    request: ModelInsightsRequest,
    window: tauri::Window,
) -> Result<WireBundle, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let locale = {
        let guard = app_state
            .locale
            .lock()
            .map_err(|e| format!("locale lock poisoned: {e}"))?;
        guard.clone()
    };
    let run = run_model_insights(&bi_state, &locale, &request).await?;
    Ok(model::to_wire(&run))
}

/// Analyse the model and write the answer down on a NEW sheet.
///
/// THE ONE MUTATING COMMAND IN THIS SUBSYSTEM. The sheet itself is created by
/// `sheets::add_sheet_inner`, which owns every per-sheet store, the user/object
/// sheet partition and the Excel-parity undo invalidation; this command's own
/// single `DocumentEffect::mutates` covers the CELLS, and is constructed after
/// the last gate that can still refuse (an empty report writes nothing and
/// creates no sheet).
#[tauri::command]
pub async fn insights_create_report_sheet(
    state: State<'_, AppState>,
    file_state: State<'_, FileState>,
    bi_state: State<'_, BiState>,
    request: ModelInsightsRequest,
    window: tauri::Window,
) -> Result<ReportSheetResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let locale = {
        let guard = state
            .locale
            .lock()
            .map_err(|e| format!("locale lock poisoned: {e}"))?;
        guard.clone()
    };

    // Everything that can refuse happens BEFORE the workbook is touched: the
    // connection, the model, the queries, and the report having anything in it
    // at all. A refused report must leave no empty sheet behind.
    let run = run_model_insights(&bi_state, &locale, &request).await?;
    let report: ReportGrid = report::build_report(&run, &locale);
    if report.rows.is_empty() {
        return Err(
            "There is nothing to report: the model produced no measures to write down."
                .to_string(),
        );
    }
    let markdown = report::report_markdown(&report, &locale);

    // Creates the sheet, switches to it, appends every per-sheet store and ends
    // the undo history — one act, and it dirties the document itself.
    let created = crate::sheets::add_sheet_inner(
        &state,
        &file_state,
        Some(unique_report_name(&state)?),
    )?;
    let sheet_index = created.active_index;
    let sheet_name = created
        .sheets
        .iter()
        .find(|s| s.index == sheet_index)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| REPORT_SHEET_BASE_NAME.to_string());

    let row_count = report.row_count();
    let col_count = report.col_count();

    // Past every gate. The cells are saved state, so they need an effect.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    {
        // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else.
        let mut current_grid = state
            .grid
            .write(&effect)
            .map_err(|e| format!("grid lock poisoned: {e}"))?;
        let mut grids = state
            .grids
            .write(&effect)
            .map_err(|e| format!("grids lock poisoned: {e}"))?;
        let mut registry = state
            .style_registry
            .write(&effect)
            .map_err(|e| format!("style_registry lock poisoned: {e}"))?;

        let mut painted = engine::grid::Grid::new();
        report::paint(&mut painted, &report, &mut registry);

        // The new sheet is the active one, so both the active grid and its slot
        // in `grids` must carry the cells; writing only one of them loses the
        // report on the next sheet switch.
        if sheet_index < grids.len() {
            grids[sheet_index] = painted.clone();
        }
        *current_grid = painted;
    }

    Ok(ReportSheetResponse {
        sheet_name,
        sheet_index,
        row_count,
        col_count,
        markdown,
        notes: run.notes,
    })
}

/// `Insights Report`, `Insights Report 2`, ... — the first name free.
///
/// Chosen BEFORE the sheet is created so the name clash is a refusal of the
/// name rather than a rename of somebody's sheet.
fn unique_report_name(state: &AppState) -> Result<String, String> {
    let names = state
        .sheet_names
        .read()
        .map_err(|e| format!("sheet_names lock poisoned: {e}"))?;
    let mut counter = 1usize;
    loop {
        let candidate = if counter == 1 {
            REPORT_SHEET_BASE_NAME.to_string()
        } else {
            format!("{REPORT_SHEET_BASE_NAME} {counter}")
        };
        if crate::sheet_names::ensure_sheet_name_is_free(&candidate, &names, None).is_ok() {
            return Ok(candidate);
        }
        counter += 1;
        if counter > 1000 {
            return Err("Could not find a free name for the report sheet.".to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The document-blind spelling and the plain document-aware one are used by
    // tests only; `run_model_insights` itself takes the PAIR, so neither belongs
    // in the module's own import list.
    use crate::insights::strategy::facts::facts_from_model_with;
    use crate::insights::strategy::facts_from_model;

    fn grid(columns: &[&str], rows: Vec<Vec<Option<String>>>) -> QueryGrid {
        QueryGrid {
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows,
        }
    }

    #[test]
    fn a_value_column_is_found_by_name_before_position() {
        // The trap: the engine put the measure in column 2, the positional
        // guess says column 1, and reading column 1 would report the DATE as
        // Revenue.
        let g = grid(
            &["Month", "Orders", "Revenue"],
            vec![vec![
                Some("2026-09".to_string()),
                Some("12".to_string()),
                Some("171".to_string()),
            ]],
        );
        let col = g.measure_column("Revenue", 1, 0).expect("found by name");
        assert_eq!(col, 2);
        assert_eq!(g.number(0, col), Some(171.0));
    }

    #[test]
    fn a_measure_the_result_does_not_name_falls_back_to_its_ordinal() {
        let g = grid(
            &["Month", "value_0", "value_1"],
            vec![vec![
                Some("2026-09".to_string()),
                Some("171".to_string()),
                Some("40".to_string()),
            ]],
        );
        assert_eq!(g.measure_column("Revenue", 1, 0), Some(1));
        assert_eq!(g.measure_column("Cost", 1, 1), Some(2));
        // ...and an ordinal past the end is None rather than a panic or a wrong
        // column.
        assert_eq!(g.measure_column("Ghost", 1, 5), None);
    }

    #[test]
    fn a_null_cell_reads_as_no_number_rather_than_zero() {
        let g = grid(
            &["Month", "Revenue"],
            vec![vec![Some("2026-09".to_string()), None]],
        );
        assert_eq!(g.number(0, 1), None);
        assert_eq!(g.text(0, 1), "");
    }

    #[test]
    fn a_kpi_status_reaches_the_reader_as_words() {
        assert_eq!(kpi_status_word(bi_engine::KpiStatus::OnTrack), "On track");
        assert_eq!(kpi_status_word(bi_engine::KpiStatus::AtRisk), "At risk");
        assert_eq!(kpi_status_word(bi_engine::KpiStatus::OffTrack), "Off track");
    }

    #[test]
    fn an_unreadable_strategy_document_is_reported_and_never_half_applied() {
        // A model whose strategy key holds something the validator would have
        // refused. The analysis must still run, from the base layer, and SAY so.
        let model = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![bi_engine::Column::new("Amount", bi_engine::DataType::Float64)],
                )
                .unwrap(),
            )
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the fixture model builds")
            .with_extension_data(std::collections::BTreeMap::from([(
                crate::bi::model_editor::STRATEGY_EXTENSION_KEY.to_string(),
                serde_json::json!({ "version": "not a number" }),
            )]));

        let mut notes = Vec::new();
        let doc = strategy_doc(&model, &mut notes);
        assert_eq!(doc, StrategyDoc::default());
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("could not be read"), "{}", notes[0]);
    }

    #[test]
    fn a_model_with_no_strategy_document_produces_no_note_at_all() {
        let model = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![bi_engine::Column::new("Amount", bi_engine::DataType::Float64)],
                )
                .unwrap(),
            )
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the fixture model builds");
        let mut notes = Vec::new();
        assert_eq!(strategy_doc(&model, &mut notes), StrategyDoc::default());
        assert!(
            notes.is_empty(),
            "an un-annotated model is the normal case, not a problem: {:?}",
            notes
        );
    }

    #[test]
    fn the_date_key_column_is_preferred_over_any_other_date_typed_column() {
        let model = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Date",
                    vec![
                        bi_engine::Column::new("Snapshot", bi_engine::DataType::Date),
                        bi_engine::Column::new("Date", bi_engine::DataType::Date)
                            .with_date_role(bi_engine::DateRole::DateKey),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![
                        bi_engine::Column::new("Amount", bi_engine::DataType::Float64),
                        bi_engine::Column::new("Date", bi_engine::DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(bi_engine::Relationship::many_to_one(
                "Sales_Date", "Sales", "Date", "Date", "Date",
            ))
            .mark_date_table("Date")
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the fixture model builds");

        let candidates = date_axis_candidates(&model, &facts_from_model(&model));
        assert_eq!(candidates[0], QualifiedColumn::new("Date", "Date"));
        assert!(candidates.contains(&QualifiedColumn::new("Date", "Snapshot")));

        // ...and with no calendar at all — no mark AND nothing that reads like
        // one — there is no axis to guess at. This used to assert "no MARK
        // means no candidates", which is no longer the rule: `facts.date_table`
        // now falls back to an inferred calendar, and a single-column Sales
        // table qualifies as nothing.
        let unmarked = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![bi_engine::Column::new("Amount", bi_engine::DataType::Float64)],
                )
                .unwrap(),
            )
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .unwrap();
        let unmarked_facts = facts_from_model(&unmarked);
        assert!(unmarked_facts.date_table.is_none(), "nothing here reads as a calendar");
        assert!(date_axis_candidates(&unmarked, &unmarked_facts).is_empty());
    }

    #[test]
    fn an_unmarked_but_recognisable_calendar_supplies_an_axis_and_says_it_guessed() {
        // THE CASCADE, at the planner's own boundary. Most models never call
        // `mark_date_table`, and until `date_axis_candidates` read the FACTS
        // rather than the declaration, every one of them got an empty candidate
        // list — no axis, so no trend, no change point, no seasonality, and
        // nothing said about why.
        let model = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![
                        bi_engine::Column::new("Amount", bi_engine::DataType::Float64),
                        bi_engine::Column::new("OrderDate", bi_engine::DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                bi_engine::Table::new(
                    "dim_date",
                    vec![
                        bi_engine::Column::new("OrderDate", bi_engine::DataType::Date),
                        bi_engine::Column::new("year", bi_engine::DataType::Decimal(38, 10)),
                        bi_engine::Column::new("quarter", bi_engine::DataType::Decimal(38, 10)),
                        bi_engine::Column::new("month", bi_engine::DataType::Decimal(38, 10)),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(bi_engine::Relationship::many_to_one(
                "Sales_Date", "Sales", "OrderDate", "dim_date", "OrderDate",
            ))
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the unmarked-calendar fixture builds");

        let facts = facts_from_model(&model);
        assert_eq!(facts.date_table.as_deref(), Some("dim_date"), "the calendar is inferred");

        let candidates = date_axis_candidates(&model, &facts);
        assert_eq!(candidates, vec![QualifiedColumn::new("dim_date", "OrderDate")]);

        // ...and the guess ANNOUNCES ITSELF. A note here is the whole licence
        // for guessing at all.
        let plan = model::plan_time_axis(&StrategyDoc::default(), &facts, &candidates);
        assert_eq!(plan.axis, Some(QualifiedColumn::new("dim_date", "OrderDate")));
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        assert!(plan.notes[0].contains("dim_date"), "{}", plan.notes[0]);
        assert!(plan.notes[0].contains("guessed"), "{}", plan.notes[0]);
    }

    #[test]
    fn the_run_builds_its_facts_with_the_strategy_document_in_hand() {
        // A SOURCE GUARD, and it is here because nothing else can hold this
        // line. `run_model_insights` needs a live connection and an engine, so
        // no test in this suite executes it — and that one call is the ENTIRE
        // wiring of an authored table kind into the run. Swapping it back to
        // `facts_from_model(&base)` reddened no test whatsoever when this was
        // measured, while silently returning the product to the defect the seam
        // was written to fix: a person corrects the calendar, and the report
        // does not follow.
        //
        // The composition it stands in for IS tested, one call down, by
        // `an_authored_calendar_supplies_the_axis_this_run_walks...`.
        const SOURCE: &str = include_str!("model_commands.rs");
        let body = SOURCE
            .split_once("pub async fn run_model_insights")
            .expect("this file defines run_model_insights")
            .1;
        // Stop at the next top-level section rule, so the tests below — which
        // legitimately call both spellings — are not part of the evidence.
        let body = body.split_once("\n// ---").map(|(b, _)| b).unwrap_or(body);
        assert!(
            body.contains("facts_with_authored_kinds(&base, &doc)"),
            "run_model_insights must build its facts WITH the stored strategy \
             document, or an authored table kind reaches no report"
        );
        assert!(
            !body.contains("facts_from_model(&base)"),
            "the document-blind spelling is back in run_model_insights"
        );
        // AND THE VERDICT MUST BE SAID OUT LOUD. Same reasoning as the line
        // above and the same reason it can only be held here: a run needs a
        // live engine, so nothing else can assert that a refused kind reaches
        // `notes`. Dropping this one call returns the product to a report that
        // quietly stops obeying a document nobody edited.
        assert!(
            body.contains("notes.extend(kind_conflict_notes("),
            "run_model_insights must push a note for every authored table kind \
             the topology refuses, or the report silently changes meaning"
        );
    }

    /// Sales -> Product (many-to-one) and Sales -> Basket (many-to-MANY), so
    /// Product is a lookup and Basket is not.
    fn a_star_with_a_bridge() -> bi_engine::DataModel {
        bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![
                        bi_engine::Column::new("Amount", bi_engine::DataType::Float64),
                        bi_engine::Column::new("ProductKey", bi_engine::DataType::Int64),
                        bi_engine::Column::new("BasketId", bi_engine::DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                bi_engine::Table::new(
                    "Product",
                    vec![
                        bi_engine::Column::new("ProductKey", bi_engine::DataType::Int64),
                        bi_engine::Column::new("Category", bi_engine::DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                bi_engine::Table::new(
                    "Basket",
                    vec![
                        bi_engine::Column::new("BasketId", bi_engine::DataType::Int64),
                        bi_engine::Column::new("Channel", bi_engine::DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(bi_engine::Relationship::many_to_one(
                "Sales_Product",
                "Sales",
                "ProductKey",
                "Product",
                "ProductKey",
            ))
            .add_relationship(bi_engine::Relationship::new(
                "Sales_Basket",
                "Sales",
                "BasketId",
                "Basket",
                "BasketId",
                bi_engine::Cardinality::ManyToMany,
            ))
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the bridge fixture builds")
    }

    fn doc_with_kinds(
        entries: &[(&str, crate::insights::strategy::TableKind)],
    ) -> StrategyDoc {
        use crate::insights::strategy::{EntrySource, TableStrategy};
        let mut doc = StrategyDoc::default();
        for (table, kind) in entries {
            doc.tables.insert(
                (*table).to_string(),
                TableStrategy {
                    kind: Some(*kind),
                    reviewed: true,
                    source: Some(EntrySource::Authored),
                    ..Default::default()
                },
            );
        }
        doc
    }

    #[test]
    fn a_kind_the_topology_refuses_is_reported_to_the_reader_of_the_run() {
        // THE SILENCE THIS CLOSES. A document that was VALID when it was saved
        // is invalidated by a later relationship edit — nothing re-validates a
        // stored document — so the run quietly stops applying a kind and the
        // report changes meaning with nothing said. `validate.rs` had the only
        // reader of these refusals, and `validate.rs` does not run here.
        use crate::insights::strategy::TableKind;

        let model = a_star_with_a_bridge();
        let doc = doc_with_kinds(&[("Basket", TableKind::Dimension)]);
        let (facts, authored) = crate::insights::strategy::facts::facts_with_authored_kinds(&model, &doc);

        assert_eq!(authored.conflicts.len(), 1, "{:?}", authored.conflicts);
        let notes = kind_conflict_notes(&facts, &authored);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("'Basket'"), "{}", notes[0]);
        assert!(notes[0].contains("'dimension'"), "the authored kind: {}", notes[0]);
        assert!(
            notes[0].contains("cannot look it up"),
            "what the topology says: {}",
            notes[0]
        );
        assert!(
            notes[0].contains("'other'"),
            "and what the run used instead: {}",
            notes[0]
        );
    }

    #[test]
    fn a_demoted_guess_takes_the_axis_away_and_the_run_says_which_dropdown_did_it() {
        // NOTHING REFUSED THIS ONE, which is exactly why it needs a note. The
        // author said the guessed calendar is an ordinary dimension, that took
        // effect, and the report simply stopped carrying trends. An absence
        // cannot announce itself.
        use crate::insights::strategy::TableKind;

        let facts = ModelFacts::default();
        let authored = AuthoredKinds {
            demoted_guess: Some("dim_date".to_string()),
            accepted: [("dim_date".to_string(), TableKind::Dimension)]
                .into_iter()
                .collect(),
            ..AuthoredKinds::default()
        };
        let notes = kind_conflict_notes(&facts, &authored);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("'dim_date'"), "{}", notes[0]);
        assert!(notes[0].contains("'dimension'"), "the kind that did it: {}", notes[0]);
        assert!(
            notes[0].contains("no time axis"),
            "the consequence, which is the whole point: {}",
            notes[0]
        );
    }

    #[test]
    fn a_strategy_document_from_a_newer_schema_is_not_applied_as_this_one() {
        // `validate.rs` refuses this at the WRITE gates with an anchored
        // finding. This path parses without validating, so a `.calp` or `.cala`
        // written by a newer build reached the planner and every rule,
        // direction and materiality in it was read with v1 meaning, in silence.
        let stored = |version: u32| {
            let mut data = std::collections::BTreeMap::new();
            data.insert(
                crate::bi::model_editor::STRATEGY_EXTENSION_KEY.to_string(),
                serde_json::json!({
                    "version": version,
                    "measures": { "Revenue": { "direction": "lowerIsBetter", "reviewed": true } }
                }),
            );
            a_star_with_a_bridge().with_extension_data(data)
        };

        let ahead = stored(STRATEGY_DOC_VERSION + 1);
        let mut notes = Vec::new();
        let doc = strategy_doc(&ahead, &mut notes);

        assert!(
            doc.measures.is_empty(),
            "a schema this build does not understand must not be applied at all"
        );
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("was not applied"), "{}", notes[0]);
        assert!(
            notes[0].contains(&(STRATEGY_DOC_VERSION + 1).to_string()),
            "the note quotes the version it was handed: {}",
            notes[0]
        );

        // POSITIVE CONTROL: the version this build DOES understand still applies
        // and says nothing, so the refusal is about the version and not about
        // the shape of the document.
        let current = stored(STRATEGY_DOC_VERSION);
        let mut clean = Vec::new();
        assert_eq!(strategy_doc(&current, &mut clean).measures.len(), 1);
        assert!(clean.is_empty(), "{clean:?}");
    }

    #[test]
    fn two_authored_calendars_are_reported_as_one_undecided_question_per_table() {
        use crate::insights::strategy::TableKind;

        // BOTH tables must be LOOKUPS, or the topology arm fires first and this
        // would be testing the other refusal. So the fixture is a star with two
        // dimensions, and the document calls both of them the calendar.
        let model = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![
                        bi_engine::Column::new("Amount", bi_engine::DataType::Float64),
                        bi_engine::Column::new("ProductKey", bi_engine::DataType::Int64),
                        bi_engine::Column::new("DateKey", bi_engine::DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                bi_engine::Table::new(
                    "Product",
                    vec![
                        bi_engine::Column::new("ProductKey", bi_engine::DataType::Int64),
                        bi_engine::Column::new("Category", bi_engine::DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                bi_engine::Table::new(
                    "Date",
                    vec![
                        bi_engine::Column::new("DateKey", bi_engine::DataType::Int64),
                        bi_engine::Column::new("full_date", bi_engine::DataType::Date),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(bi_engine::Relationship::many_to_one(
                "Sales_Product",
                "Sales",
                "ProductKey",
                "Product",
                "ProductKey",
            ))
            .add_relationship(bi_engine::Relationship::many_to_one(
                "Sales_Date", "Sales", "DateKey", "Date", "DateKey",
            ))
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the two-lookup fixture builds");

        let doc = doc_with_kinds(&[
            ("Date", TableKind::Calendar),
            ("Product", TableKind::Calendar),
        ]);
        let (facts, authored) = crate::insights::strategy::facts::facts_with_authored_kinds(&model, &doc);
        assert_eq!(authored.calendar, None, "ambiguity applies neither");
        let notes = kind_conflict_notes(&facts, &authored);
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(notes.iter().all(|n| n.contains("'calendar'")), "{notes:?}");
        assert!(notes[0].contains("'Date'") && notes[0].contains("'Product'"), "{}", notes[0]);
    }

    #[test]
    fn a_document_whose_kinds_all_stand_produces_no_note_at_all() {
        // The control. A note per run for a document that is entirely correct
        // would be noise, and noise is how a real note stops being read.
        use crate::insights::strategy::TableKind;

        let model = a_star_with_a_bridge();
        let doc = doc_with_kinds(&[("Product", TableKind::Dimension), ("Sales", TableKind::Fact)]);
        let (facts, authored) = crate::insights::strategy::facts::facts_with_authored_kinds(&model, &doc);
        assert!(authored.conflicts.is_empty(), "{:?}", authored.conflicts);
        assert!(kind_conflict_notes(&facts, &authored).is_empty());
    }

    #[test]
    fn an_authored_calendar_supplies_the_axis_this_run_walks_and_says_it_was_chosen() {
        // THE RUN PATH, END TO END. Two role-playing date tables: the heuristic
        // refuses to pick one, so this model has no time axis and no trend,
        // change-point or seasonality fact at all. A person picks one in the
        // Strategy tab — and until `run_model_insights` built its facts WITH the
        // document, that correction changed nothing whatsoever.
        use crate::insights::strategy::{EntrySource, TableKind, TableStrategy};

        let mut builder = bi_engine::DataModel::builder().add_table(
            bi_engine::Table::new(
                "Sales",
                vec![
                    bi_engine::Column::new("Amount", bi_engine::DataType::Float64),
                    bi_engine::Column::new("OrderDateKey", bi_engine::DataType::Int64),
                    bi_engine::Column::new("ShipDateKey", bi_engine::DataType::Int64),
                ],
            )
            .unwrap(),
        );
        for name in ["dim_order_date", "dim_ship_date"] {
            builder = builder.add_table(
                bi_engine::Table::new(
                    name,
                    vec![
                        bi_engine::Column::new("date_key", bi_engine::DataType::Int64),
                        bi_engine::Column::new("full_date", bi_engine::DataType::Date),
                        bi_engine::Column::new("year", bi_engine::DataType::Int32),
                        bi_engine::Column::new("month", bi_engine::DataType::Int32),
                    ],
                )
                .unwrap(),
            );
        }
        let model = builder
            .add_relationship(bi_engine::Relationship::many_to_one(
                "Sales_Order",
                "Sales",
                "OrderDateKey",
                "dim_order_date",
                "date_key",
            ))
            .add_relationship(bi_engine::Relationship::many_to_one(
                "Sales_Ship",
                "Sales",
                "ShipDateKey",
                "dim_ship_date",
                "date_key",
            ))
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
            .build()
            .expect("the role-playing fixture builds");

        // The control: with no document, nothing here can be a time axis.
        let raw = facts_from_model(&model);
        assert_eq!(raw.date_table, None, "ambiguity refuses");
        assert!(date_axis_candidates(&model, &raw).is_empty());

        let mut doc = StrategyDoc::default();
        doc.tables.insert(
            "dim_order_date".to_string(),
            TableStrategy {
                kind: Some(TableKind::Calendar),
                reviewed: true,
                source: Some(EntrySource::Authored),
                ..Default::default()
            },
        );

        let facts = facts_from_model_with(&model, &doc);
        assert_eq!(facts.date_table.as_deref(), Some("dim_order_date"));
        let candidates = date_axis_candidates(&model, &facts);
        assert_eq!(
            candidates,
            vec![QualifiedColumn::new("dim_order_date", "full_date")]
        );

        let plan = model::plan_time_axis(&doc, &facts, &candidates);
        assert_eq!(
            plan.axis,
            Some(QualifiedColumn::new("dim_order_date", "full_date"))
        );
        // A CHOICE ANNOUNCES ITSELF TOO, and not as a guess: the model still
        // marks no date table, so the report has a time axis while the model's
        // own time-intelligence measures do not.
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        assert!(
            plan.notes[0].contains("strategy document"),
            "{}",
            plan.notes[0]
        );
        assert!(
            !plan.notes[0].contains("guessed"),
            "a chosen calendar is not a guess: {}",
            plan.notes[0]
        );
    }

    #[test]
    fn the_query_ceiling_is_smaller_than_the_worst_case_plan() {
        // The ceiling exists to be BELOW the product of the two caps; if it
        // ever rises above it, it has stopped bounding anything.
        assert!(
            MAX_QUERIES_PER_RUN
                < model::MAX_MEASURES_PER_RUN * (1 + model::MAX_DIMENSIONS_PER_MEASURE),
            "a ceiling nobody can reach is not a ceiling"
        );
    }
}
