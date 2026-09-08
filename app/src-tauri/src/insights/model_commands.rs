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
use super::strategy::{facts_from_model, resolve, ModelFacts, QualifiedColumn, ScopePoint, StrategyDoc, Target};
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

/// Candidate time-axis columns of the marked date table, best first.
///
/// A column the model tagged `DateKey` is the model author's own answer. Failing
/// that, the first `Date`/`Timestamp`-typed column in declaration order — which
/// is a guess, but a guess about which column holds dates, not about what
/// "good" means.
fn date_axis_candidates(model: &bi_engine::DataModel) -> Vec<QualifiedColumn> {
    let Some(table_name) = model.date_table() else {
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
    let facts: ModelFacts = facts_from_model(&base);

    let axis = model::choose_time_axis(&doc, &facts, &date_axis_candidates(&base));
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

    // KPI bands, indexed by the measure they mark up. `facts_from_model` keeps
    // only the thresholds; the band NAMES are what a reader acts on, so they
    // are read from the model here rather than smuggled into `ModelFacts`.
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

        let candidates = date_axis_candidates(&model);
        assert_eq!(candidates[0], QualifiedColumn::new("Date", "Date"));
        assert!(candidates.contains(&QualifiedColumn::new("Date", "Snapshot")));

        // ...and with no marked date table there is no axis to guess at.
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
        assert!(date_axis_candidates(&unmarked).is_empty());
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
