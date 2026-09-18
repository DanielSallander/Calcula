//! FILENAME: app/src-tauri/src/insights/commands.rs
// PURPOSE: The two commands behind "what is going on in this range" and "what is
//          going on in this chart" -- the raw-grid half of the Insights seam.
// CONTEXT: Both are READ-ONLY and construct no `DocumentEffect` of any kind.
//          They read cells, they read the hidden-row sets, they read the
//          workbook locale, and they return a bundle. Nothing they touch is
//          saved state, so dirtying the document here would put an asterisk in
//          the title bar for asking a question.
//
//          THE LOCK ORDER IS NOT INCIDENTAL. `collect_hidden_rows_for_sheet`
//          takes its own locks (auto_filters, the advanced-filter map, outlines,
//          the per-sheet user-hidden sets), so it is called while NO grid lock
//          is held -- the same discipline `get_special_cells` follows next door,
//          and for the same reason: Tauri dispatches commands on a thread pool.
//
//          THE ACTIVE SHEET'S LIVE GRID IS `state.grid`, NOT `grids[active]`.
//          The latter is stale between recalculations, and an analysis of stale
//          cells is a confident answer about numbers the user cannot see.
//
//          A CHART'S BLANK IS NOT A ZERO. `insights_for_series` takes
//          `Option<f64>` per point and keeps `None` as `Datum::Blank`. This is
//          the entire reason the Charts seam carries an Option: a month with no
//          data rendered as 0.0 turns a gap into a collapse, and the sentence
//          "Revenue fell 100% in March" would be produced from data that says
//          nothing about March at all.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::State;

use insights::types::{Column, Dataset, Datum, RangeRef, SourceRef};
use insights::AnalyzeOptions;

use crate::bi::types::BiState;
use crate::insights::region;
use crate::insights::series_strategy::{self, SeriesStrategyContext};
use crate::insights::wire::{self, BundleSource, WireBundle};
use crate::AppState;

// ---------------------------------------------------------------------------
// Requests (mirrors of the seam's TypeScript, camelCase over the wire)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeInsightsRequest {
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    /// Expand a single cell to its surrounding block first. Absent means no:
    /// the seam declares it optional, and analysing more than the user selected
    /// is the surprising default.
    #[serde(default)]
    pub expand_to_region: bool,
}

/// One plotted series, exactly as the Charts seam produces it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesInput {
    pub name: String,
    /// `None` is a MISSING point, not a zero. See the module header.
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesInsightsRequest {
    pub title: String,
    pub categories: Vec<String>,
    /// "text" | "number" | "date" as the chart understands its own axis.
    pub category_kind: String,
    /// The numeric x of a scatter, when there is one.
    #[serde(default)]
    pub category_values: Option<Vec<f64>>,
    pub series: Vec<SeriesInput>,
    /// The strategy behind the chart, when the chart knows it (a design-query
    /// chart does; a range chart does not). Absent, the route behaves exactly
    /// as before: plain facts, no direction, no materiality.
    #[serde(default)]
    pub strategy: Option<SeriesStrategyContext>,
}

/// Why a range inside a pivot table is refused rather than analysed.
///
/// A pivot's cells look like a rectangle of numbers and are not one: a grand
/// total is a row in the same column as the rows it sums, so the contribution
/// fact reads it as a peer and says "Grand Total is 50% of all Revenue" — a
/// sentence that is arithmetically true and means nothing. The same goes for
/// subtotals, for a measure and its percentage laid side by side, and for a
/// row-header column of member names read as a category.
///
/// Refusing is the honest answer, and the message names the route that does
/// work: a pivot over a MODEL is analysed from the model's own facts, where a
/// total is a total and a member is a member.
pub(crate) const PIVOT_RANGE_REFUSAL: &str = "A pivot table's cells are not a range of numbers: its totals would be compared with the rows they summarise. For a pivot built on a model, right-click it and choose \"Show points of interest\" instead.";

/// Do two inclusive rectangles on the same sheet touch at all?
///
/// Rows and columns are two independent one-dimensional tests; both must
/// overlap for the rectangles to.
fn rects_overlap(a: (u32, u32, u32, u32), b: (u32, u32, u32, u32)) -> bool {
    let (a_sr, a_sc, a_er, a_ec) = a;
    let (b_sr, b_sc, b_er, b_ec) = b;
    let rows_meet = a_sr <= b_er && b_sr <= a_er;
    let cols_meet = a_sc <= b_ec && b_sc <= a_ec;
    rows_meet && cols_meet
}

/// Refuse a rectangle that touches any of the sheet's pivot tables.
///
/// Takes the pivot rectangles as a snapshot so no lock is held across it: see
/// [`crate::pivot::operations::pivot_rects_on_sheet`].
fn refuse_if_in_a_pivot(
    pivots: &[(u32, u32, u32, u32)],
    rect: (u32, u32, u32, u32),
) -> Result<(), String> {
    if pivots.iter().any(|p| rects_overlap(*p, rect)) {
        return Err(PIVOT_RANGE_REFUSAL.to_string());
    }
    Ok(())
}

/// The name given to the axis column of a chart dataset.
pub const CATEGORY_COLUMN: &str = "Category";
/// The name given to a numeric x axis carried alongside its labels.
pub const CATEGORY_VALUE_COLUMN: &str = "Category value";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Deterministic facts about a rectangle of cells. Needs no model and no AI.
///
/// Read-only: no `DocumentEffect`, nothing persisted changes.
#[tauri::command]
pub fn insights_analyze_range(
    request: RangeInsightsRequest,
    state: State<AppState>,
    window: tauri::Window,
) -> Result<WireBundle, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    analyze_range_impl(&state, &request)
}

/// The body of `insights_analyze_range`, without the window guard.
///
/// Split out so the MCP surface can offer the same analysis to an external AI
/// client. The guard stays on the COMMAND rather than moving in here, because an
/// MCP call arrives with no window at all — it is gated by the server's own AI
/// access level instead, and pretending it came from the main window would be
/// the wrong shape of lie.
///
/// Read-only, so there is no `DocumentEffect` to duplicate either.
pub(crate) fn analyze_range_impl(
    state: &AppState,
    request: &RangeInsightsRequest,
) -> Result<WireBundle, String> {
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let sheet_names: Vec<String> = state
        .sheet_names
        .read()
        .map_err(|e| e.to_string())?
        .clone();
    let target = request.sheet_index;
    if target >= sheet_names.len() {
        return Err(format!("sheet index out of range: {}", target));
    }
    let sheet_name = sheet_names[target].clone();

    // Gathered while holding NO grid lock -- this takes four locks of its own.
    let hidden_rows: HashSet<u32> =
        crate::commands::nav::collect_hidden_rows_for_sheet(&state, target);

    // A pivot's cells are refused, not analysed (see PIVOT_RANGE_REFUSAL). The
    // rectangles are snapshotted here, with no other lock held, and the request
    // is checked twice: once as asked, and again after `plan_region` has had its
    // say -- a single cell beside a pivot EXPANDS into it, and the analysis
    // would then be of the pivot under another name.
    let pivots = crate::pivot::operations::pivot_rects_on_sheet(&state, target);
    refuse_if_in_a_pivot(
        &pivots,
        (
            request.start_row.min(request.end_row),
            request.start_col.min(request.end_col),
            request.start_row.max(request.end_row),
            request.start_col.max(request.end_col),
        ),
    )?;

    let (plan, dataset, locale_id) = {
        let active_grid = state.grid.read().map_err(|e| e.to_string())?;
        let grids = state.grids.read().map_err(|e| e.to_string())?;
        let grid: &engine::grid::Grid = if target == active_sheet {
            &active_grid
        } else if target < grids.len() {
            &grids[target]
        } else {
            return Err(format!("sheet index out of range: {}", target));
        };
        let styles = state.style_registry.read().map_err(|e| e.to_string())?;
        let locale = state.locale.lock().map_err(|e| e.to_string())?;

        let plan = region::plan_region(
            grid,
            &sheet_name,
            request.start_row,
            request.start_col,
            request.end_row,
            request.end_col,
            request.expand_to_region,
            &hidden_rows,
        );
        // `pivots` is an owned snapshot, so this takes no lock: `?` here simply
        // returns, dropping the grid guards on the way out.
        refuse_if_in_a_pivot(
            &pivots,
            (
                plan.range.start_row,
                plan.range.start_col,
                plan.range.end_row,
                plan.range.end_col,
            ),
        )?;
        let dataset = region::extract_dataset(grid, &styles, &locale, &sheet_name, &plan);
        (plan, dataset, locale.locale_id.clone())
    };

    let bundle = analyze_with_notes(&dataset, &locale_id, plan.notes);
    Ok(wire::from_core_with_sheets(
        bundle,
        BundleSource::Range,
        &sheet_names,
    ))
}

/// Deterministic facts about a plotted chart, from what the Charts seam already
/// has in hand. The chart is never re-read from the grid: the numbers on screen
/// are the numbers analysed.
///
/// Read-only: no `DocumentEffect`, nothing persisted changes.
#[tauri::command]
pub fn insights_for_series(
    request: SeriesInsightsRequest,
    state: State<AppState>,
    bi_state: State<BiState>,
    window: tauri::Window,
) -> Result<WireBundle, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let locale_id = state
        .locale
        .lock()
        .map_err(|e| e.to_string())?
        .locale_id
        .clone();

    let (dataset, mut notes) = dataset_from_series(&request);

    // WITH A STRATEGY, the facts about a bound series carry the measure's
    // direction and are gated by its materiality -- the model route's own
    // rules, applied through `analyze_with_policy` BEFORE ranking so nothing
    // withheld leaks into the markdown or the facts. Without one, the plain
    // analyser runs exactly as it always has.
    let bundle = match request.strategy.as_ref() {
        Some(context) => {
            let bindings = series_strategy::bindings_for(&bi_state, context, &mut notes)?;
            let mut withheld = series_strategy::Withheld::default();
            let mut bundle = insights::analyze_with_policy(
                &dataset,
                &AnalyzeOptions::for_locale_id(&locale_id),
                &mut |insight| {
                    let verdict = series_strategy::judge(insight, &bindings);
                    withheld.record(verdict);
                    verdict.keeps()
                },
            );
            notes.extend(withheld.notes());
            notes.append(&mut bundle.notes);
            bundle.notes = notes;
            bundle
        }
        None => analyze_with_notes(&dataset, &locale_id, notes),
    };
    // A chart's series live in no sheet, so there is no sheet name to resolve
    // and every fact's evidence is the series itself.
    Ok(wire::from_core(bundle, BundleSource::Range))
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Run the analysis and put the caller's notes in FRONT of the analysis's own.
///
/// Order matters to a reader: "3 hidden rows were excluded" is context for
/// everything that follows, and printed after the findings it reads like a
/// footnote nobody gets to.
fn analyze_with_notes(
    dataset: &Dataset,
    locale_id: &str,
    mut notes: Vec<String>,
) -> insights::types::InsightBundle {
    let mut bundle = insights::analyze(dataset, &AnalyzeOptions::for_locale_id(locale_id));
    notes.append(&mut bundle.notes);
    bundle.notes = notes;
    bundle
}

/// Build the dataset a chart's series describe.
///
/// Pure, and separate from the command so the `None`-stays-absent rule can be
/// tested without a `Window`.
///
/// THE CATEGORY AXIS. The labels always become a TEXT column, because that is
/// what makes a finding say "peaks in March" rather than "peaks at position 3".
/// A numeric x (a scatter) is carried as an ADDITIONAL column placed LAST, so
/// it can be correlated with the series while leaving the first numeric column
/// -- the one a category breakdown pairs with -- as the first real series.
/// Category values that were supplied but cannot be used are reported in the
/// notes rather than dropped in silence.
pub fn dataset_from_series(request: &SeriesInsightsRequest) -> (Dataset, Vec<String>) {
    let mut notes: Vec<String> = Vec::new();

    let rows = request
        .series
        .iter()
        .map(|s| s.values.len())
        .max()
        .unwrap_or(0)
        .max(request.categories.len());

    let mut columns: Vec<Column> = Vec::new();

    let mut category_cells: Vec<Datum> = request
        .categories
        .iter()
        .map(|c| {
            if c.trim().is_empty() {
                Datum::Blank
            } else {
                Datum::Text(c.clone())
            }
        })
        .collect();
    category_cells.resize(rows, Datum::Blank);
    columns.push(series_column(CATEGORY_COLUMN, columns.len(), category_cells));

    for series in &request.series {
        let mut cells: Vec<Datum> = series
            .values
            .iter()
            .map(|v| match v {
                // A missing point stays missing. A non-finite one is not a
                // measurement either, and letting a NaN through would poison
                // every mean computed from the column.
                Some(n) if n.is_finite() => Datum::Number(*n),
                _ => Datum::Blank,
            })
            .collect();
        cells.resize(rows, Datum::Blank);
        columns.push(series_column(&series.name, columns.len(), cells));
    }

    let numeric_axis = request.category_kind.eq_ignore_ascii_case("number");
    match (&request.category_values, numeric_axis) {
        (Some(values), true) if values.len() == request.categories.len() => {
            let mut cells: Vec<Datum> = values
                .iter()
                .map(|v| {
                    if v.is_finite() {
                        Datum::Number(*v)
                    } else {
                        Datum::Blank
                    }
                })
                .collect();
            cells.resize(rows, Datum::Blank);
            columns.push(series_column(CATEGORY_VALUE_COLUMN, columns.len(), cells));
        }
        (Some(values), true) => {
            notes.push(format!(
                "The chart supplied {} category values for {} categories, so the axis was read as labels only.",
                values.len(),
                request.categories.len()
            ));
        }
        (Some(_), false) => {
            notes.push(format!(
                "The chart's category axis is \"{}\", so its numeric values were read as labels rather than as measurements.",
                request.category_kind
            ));
        }
        (None, _) => {}
    }

    let label = if request.title.trim().is_empty() {
        "the chart".to_string()
    } else {
        request.title.clone()
    };

    let dataset = Dataset {
        source: SourceRef {
            label,
            // A chart's series are not cells. Naming a sheet here would put a
            // wrong A1 string under every finding.
            sheet: String::new(),
            range: None,
        },
        // The column names came from the chart, not from a row of the data.
        has_header: true,
        row_origins: Vec::new(),
        columns,
    };
    (dataset, notes)
}

/// A chart's series is not cells, so its `Column` carries an EMPTY sheet name.
/// The wire mapper reads that as "describe, do not locate" and emits no
/// rectangle at all.
///
/// The placeholder range still differs per column, because `Subject::key`
/// combines name and range into a fact's identity: two series that a chart
/// legitimately named the same thing would otherwise collapse into one id and
/// the ranker would silently discard one of them as a duplicate.
fn series_column(name: &str, index: usize, cells: Vec<Datum>) -> Column {
    Column {
        name: name.to_string(),
        sheet: String::new(),
        range: RangeRef::new("", 0, index as u32, 0, index as u32),
        cells,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use insights::types::{ColumnRole, FactKind};

    fn request(values: Vec<Vec<Option<f64>>>) -> SeriesInsightsRequest {
        let categories: Vec<String> = (0..values.first().map(|v| v.len()).unwrap_or(0))
            .map(|i| format!("M{:02}", i + 1))
            .collect();
        SeriesInsightsRequest {
            title: "Revenue by month".to_string(),
            categories,
            category_kind: "text".to_string(),
            category_values: None,
            series: values
                .into_iter()
                .enumerate()
                .map(|(i, v)| SeriesInput {
                    name: format!("S{}", i + 1),
                    values: v,
                })
                .collect(),
            strategy: None,
        }
    }

    #[test]
    fn the_request_reads_the_seams_camel_case_with_and_without_a_strategy() {
        // THE FIELD-NAME PIN for the request half. The seam's TypeScript sends
        // `categoryKind` and, for a design-query chart, `strategy.connectionId`;
        // a rename on either side fails here rather than in a running app.
        let plain = r#"{"title":"T","categories":["Jan"],"categoryKind":"text","series":[{"name":"S","values":[1.0,null]}]}"#;
        let req: SeriesInsightsRequest = serde_json::from_str(plain).expect("strategy is optional");
        assert!(req.strategy.is_none());
        assert_eq!(req.series[0].values, vec![Some(1.0), None]);

        let with = r#"{"title":"T","categories":["Jan"],"categoryKind":"text","series":[],
            "strategy":{"connectionId":"6f1c2a3e-9b8d-4c5e-8a7f-0123456789ab","measures":[{"series":"Cost","measure":"Total Cost"}]}}"#;
        let req: SeriesInsightsRequest = serde_json::from_str(with).expect("camelCase strategy");
        let strategy = req.strategy.expect("present");
        assert_eq!(strategy.measures[0].series, "Cost");
        assert_eq!(strategy.measures[0].measure, "Total Cost");
    }

    #[test]
    fn an_extremes_fact_on_a_chart_series_carries_the_painter_index_of_its_label() {
        // The chart route's whole reason for indices: a blank month before
        // the peak must not shift the ring one bar left. M02 is blank, so the
        // peak at M06 is analysed position 4 and supplied index 5.
        let req = request(vec![vec![
            Some(100.0),
            None,
            Some(120.0),
            Some(130.0),
            Some(140.0),
            Some(190.0),
            Some(150.0),
        ]]);
        let (dataset, _) = dataset_from_series(&req);
        let bundle = insights::analyze(&dataset, &AnalyzeOptions::default());
        let (label, index) = bundle
            .insights
            .iter()
            .find_map(|i| match &i.kind {
                FactKind::Extremes { best_label, best_index, .. } => Some((best_label.clone(), *best_index)),
                _ => None,
            })
            .expect("seven points is enough for an extremes fact");
        assert_eq!(label, "M06");
        assert_eq!(index, 5, "the index must count the blank at M02");
        assert_eq!(req.categories[index], label, "index and label name the same category");
    }

    #[test]
    fn a_blank_series_point_stays_absent_all_the_way_through_and_never_becomes_zero() {
        // THE test this command exists to keep true. A zero here would make a
        // chart with a blank month look like a collapse.
        let req = request(vec![vec![
            Some(100.0),
            None,
            Some(120.0),
            Some(130.0),
            Some(140.0),
            Some(150.0),
        ]]);
        let (dataset, _notes) = dataset_from_series(&req);

        let series = &dataset.columns[1];
        assert_eq!(series.cells[1], Datum::Blank, "None must stay Blank");
        assert!(
            !series.numbers().contains(&0.0),
            "a gap became a zero: {:?}",
            series.numbers()
        );
        assert!(
            series.aligned_numbers()[1].is_nan(),
            "a hole must stay a hole in the row-aligned view too"
        );
        assert_eq!(series.role(), ColumnRole::Numeric);

        // ...and through the analysis, where a zero would be visible as a
        // minimum of 0 over data whose smallest real value is 100.
        let bundle = insights::analyze(&dataset, &AnalyzeOptions::default());
        let summary = bundle
            .insights
            .iter()
            .map(|i| &i.kind)
            .find_map(|k| match k {
                FactKind::ColumnSummary {
                    subject, n, min, ..
                } if subject.label() == "S1" => Some((*n, *min)),
                _ => None,
            })
            .expect("a numeric series is summarised");
        assert_eq!(summary.0, 5, "the blank must not be counted as a value");
        assert_eq!(summary.1, 100.0, "the blank must not become the minimum");
        // And the fact a reader would actually see the lie in: the worst month.
        // A zeroed blank makes the second month the collapse of the year.
        let worst = bundle
            .insights
            .iter()
            .map(|i| &i.kind)
            .find_map(|k| match k {
                FactKind::Extremes {
                    subject,
                    worst_label,
                    worst,
                    ..
                } if subject.label() == "S1" => Some((worst_label.clone(), *worst)),
                _ => None,
            })
            .expect("six points is enough for an extremes fact");
        assert_eq!(worst.1, 100.0);
        assert_eq!(worst.0, "M01", "M02 has no value at all and cannot be worst");
    }

    #[test]
    fn a_non_finite_series_point_is_treated_as_missing_rather_than_as_a_number() {
        let req = request(vec![vec![Some(1.0), Some(f64::NAN), Some(f64::INFINITY), Some(4.0)]]);
        let (dataset, _) = dataset_from_series(&req);
        assert_eq!(dataset.columns[1].cells[1], Datum::Blank);
        assert_eq!(dataset.columns[1].cells[2], Datum::Blank);
        assert_eq!(dataset.columns[1].numbers(), vec![1.0, 4.0]);
    }

    #[test]
    fn the_categories_become_the_label_column_so_a_finding_names_a_month() {
        let req = request(vec![vec![
            Some(10.0),
            Some(90.0),
            Some(20.0),
            Some(30.0),
            Some(40.0),
            Some(50.0),
        ]]);
        let (dataset, _) = dataset_from_series(&req);
        assert_eq!(dataset.columns[0].name, CATEGORY_COLUMN);
        assert_eq!(dataset.columns[0].role(), ColumnRole::Text);
        assert_eq!(dataset.labels()[1], "M02");

        let bundle = insights::analyze(&dataset, &AnalyzeOptions::default());
        assert!(
            bundle.markdown.contains("M02"),
            "the peak must be named by its category:\n{}",
            bundle.markdown
        );
    }

    #[test]
    fn a_numeric_axis_is_carried_as_its_own_column_and_placed_after_the_series() {
        let mut req = request(vec![vec![Some(2.0), Some(4.0), Some(6.0), Some(8.0)]]);
        req.category_kind = "number".to_string();
        req.category_values = Some(vec![1.0, 2.0, 3.0, 4.0]);
        let (dataset, notes) = dataset_from_series(&req);

        let names: Vec<&str> = dataset.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec![CATEGORY_COLUMN, "S1", CATEGORY_VALUE_COLUMN]);
        assert_eq!(dataset.columns[2].numbers(), vec![1.0, 2.0, 3.0, 4.0]);
        assert!(notes.is_empty(), "nothing was dropped, so nothing to say");
    }

    #[test]
    fn category_values_that_cannot_be_used_are_reported_rather_than_dropped_in_silence() {
        let mut mismatched = request(vec![vec![Some(2.0), Some(4.0), Some(6.0), Some(8.0)]]);
        mismatched.category_kind = "number".to_string();
        mismatched.category_values = Some(vec![1.0, 2.0]);
        let (dataset, notes) = dataset_from_series(&mismatched);
        assert_eq!(dataset.columns.len(), 2, "no phantom axis column");
        assert!(
            notes.iter().any(|n| n.contains("2 category values for 4")),
            "{:?}",
            notes
        );

        let mut text_axis = request(vec![vec![Some(2.0), Some(4.0), Some(6.0), Some(8.0)]]);
        text_axis.category_values = Some(vec![1.0, 2.0, 3.0, 4.0]);
        let (_, notes) = dataset_from_series(&text_axis);
        assert!(
            notes.iter().any(|n| n.contains("read as labels")),
            "{:?}",
            notes
        );
    }

    #[test]
    fn a_series_shorter_than_its_categories_is_padded_with_blanks_not_with_zeros() {
        let mut req = request(vec![vec![Some(1.0), Some(2.0), Some(3.0), Some(4.0)]]);
        req.series.push(SeriesInput {
            name: "S2".to_string(),
            values: vec![Some(9.0), Some(8.0)],
        });
        let (dataset, _) = dataset_from_series(&req);
        assert_eq!(dataset.row_count(), 4);
        assert_eq!(dataset.columns[2].cells.len(), 4);
        assert_eq!(dataset.columns[2].cells[3], Datum::Blank);
        assert_eq!(dataset.columns[2].numbers(), vec![9.0, 8.0]);
    }

    #[test]
    fn a_chart_with_no_title_still_produces_a_bundle_that_names_something() {
        let mut req = request(vec![vec![Some(1.0), Some(2.0), Some(3.0)]]);
        req.title = "   ".to_string();
        let (dataset, _) = dataset_from_series(&req);
        assert_eq!(dataset.source.label, "the chart");
        assert!(dataset.source.range.is_none());
    }

    #[test]
    fn the_callers_notes_are_stated_before_the_analysis_own() {
        let (dataset, _) = dataset_from_series(&request(vec![vec![Some(1.0), Some(2.0)]]));
        let bundle = analyze_with_notes(&dataset, "en-US", vec!["mine first".to_string()]);
        assert_eq!(bundle.notes.first().map(String::as_str), Some("mine first"));
    }

    #[test]
    fn a_swedish_workbook_narrates_a_chart_with_a_decimal_comma() {
        let values: Vec<Option<f64>> = (0..20).map(|i| Some(100.0 + 2.5 * i as f64)).collect();
        let (dataset, _) = dataset_from_series(&request(vec![values]));
        let sv = analyze_with_notes(&dataset, "sv-SE", Vec::new());
        let en = analyze_with_notes(&dataset, "en-US", Vec::new());
        assert_eq!(sv.locale_id, "sv-SE");
        assert!(sv.markdown.contains(','), "{}", sv.markdown);
        assert_ne!(sv.markdown, en.markdown);
    }

    #[test]
    fn a_range_request_deserializes_from_the_seams_camel_case_with_expansion_absent() {
        let request: RangeInsightsRequest = serde_json::from_str(
            r#"{"sheetIndex":2,"startRow":0,"startCol":1,"endRow":9,"endCol":3}"#,
        )
        .expect("the seam's shape must deserialize");
        assert_eq!(request.sheet_index, 2);
        assert_eq!(request.end_col, 3);
        assert!(
            !request.expand_to_region,
            "an absent expandToRegion must not silently widen the analysis"
        );

        let expanded: RangeInsightsRequest = serde_json::from_str(
            r#"{"sheetIndex":0,"startRow":4,"startCol":4,"endRow":4,"endCol":4,"expandToRegion":true}"#,
        )
        .expect("deserializes");
        assert!(expanded.expand_to_region);
    }

    #[test]
    fn a_series_request_deserializes_with_a_null_point_intact() {
        let request: SeriesInsightsRequest = serde_json::from_str(
            r#"{"title":"Q1","categories":["Jan","Feb"],"categoryKind":"text",
                "series":[{"name":"Revenue","values":[10.5,null]}]}"#,
        )
        .expect("the Charts seam's shape must deserialize");
        assert_eq!(request.series[0].values, vec![Some(10.5), None]);
        assert!(request.category_values.is_none());

        let (dataset, _) = dataset_from_series(&request);
        assert_eq!(dataset.columns[1].cells[1], Datum::Blank);
    }

    #[test]
    fn a_chart_bundle_reaches_the_wire_as_a_range_bundle_with_no_provenance() {
        let (dataset, _) = dataset_from_series(&request(vec![vec![
            Some(10.0),
            Some(20.0),
            Some(30.0),
            Some(40.0),
            Some(50.0),
            Some(60.0),
        ]]));
        let bundle = analyze_with_notes(&dataset, "en-US", Vec::new());
        let wire = wire::from_core(bundle, BundleSource::Range);
        assert!(!wire.insights.is_empty());
        for insight in &wire.insights {
            assert!(
                insight.provenance.is_empty(),
                "a raw-grid fact declares no strategy provenance"
            );
        }
    }

    // -----------------------------------------------------------------------
    // The pivot refusal
    // -----------------------------------------------------------------------

    /// A pivot at rows 5..=20, columns 2..=6.
    fn a_pivot() -> Vec<(u32, u32, u32, u32)> {
        vec![(5, 2, 20, 6)]
    }

    #[test]
    fn a_range_inside_a_pivot_is_refused_and_the_message_names_the_route_that_works() {
        let err = refuse_if_in_a_pivot(&a_pivot(), (7, 3, 9, 4)).unwrap_err();
        assert_eq!(err, PIVOT_RANGE_REFUSAL);
        assert!(
            err.contains("Show points of interest"),
            "the refusal must name what to do instead, not just say no: {err}"
        );
    }

    #[test]
    fn a_range_that_merely_clips_a_pivot_is_refused_too() {
        // Reaching over the pivot's top-left corner from outside still reads its
        // totals as peers of the rows above them.
        for rect in [
            (1, 1, 6, 3),   // down into the top-left corner
            (18, 5, 30, 9), // up into the bottom-right corner
            (0, 4, 40, 4),  // a whole column straight through it
            (10, 0, 10, 99), // a whole row straight through it
            (5, 2, 20, 6),  // exactly the pivot
            (0, 0, 99, 99), // the pivot and everything around it
        ] {
            assert!(
                refuse_if_in_a_pivot(&a_pivot(), rect).is_err(),
                "{rect:?} touches the pivot and must be refused"
            );
        }
    }

    #[test]
    fn a_range_beside_a_pivot_is_analysed_as_usual() {
        // One row above, one row below, one column left, one column right, and a
        // rectangle diagonally off the corner: none of them is the pivot.
        for rect in [
            (0, 2, 4, 6),
            (21, 2, 30, 6),
            (5, 0, 20, 1),
            (5, 7, 20, 9),
            (0, 0, 4, 1),
            (21, 7, 30, 9),
        ] {
            assert!(
                refuse_if_in_a_pivot(&a_pivot(), rect).is_ok(),
                "{rect:?} is outside the pivot and must be analysed"
            );
        }
    }

    #[test]
    fn a_sheet_with_no_pivots_refuses_nothing() {
        assert!(refuse_if_in_a_pivot(&[], (0, 0, 1_000, 1_000)).is_ok());
    }

    #[test]
    fn overlap_is_two_independent_one_dimensional_tests() {
        // Rows meet, columns do not: no overlap. This is the pair a folded
        // one-liner gets wrong, and it is the difference between refusing the
        // pivot and refusing the whole sheet row it sits on.
        assert!(!rects_overlap((5, 2, 20, 6), (5, 7, 20, 9)));
        assert!(!rects_overlap((5, 2, 20, 6), (21, 2, 30, 6)));
        assert!(rects_overlap((5, 2, 20, 6), (20, 6, 30, 9))); // one shared cell
        assert!(rects_overlap((5, 2, 20, 6), (5, 2, 5, 2))); // the top-left cell alone
    }

    // -----------------------------------------------------------------------
    // The pivot refusal, through the real command
    // -----------------------------------------------------------------------

    fn cell_number(n: f64) -> engine::cell::Cell {
        engine::cell::Cell {
            ast: None,
            value: engine::cell::CellValue::Number(n),
            style_index: 0,
            rich_text: None,
        }
    }

    fn cell_text(s: &str) -> engine::cell::Cell {
        engine::cell::Cell {
            ast: None,
            value: engine::cell::CellValue::Text(s.to_string()),
            style_index: 0,
            rich_text: None,
        }
    }

    /// One contiguous block, `Region | Revenue`, rows 0..=10 — a header and ten
    /// data rows — with a `"pivot"` region declared over its lower half
    /// (rows 6..=10), the shape a pivot dropped under a list of numbers makes.
    fn state_with_a_pivot_below_a_block() -> AppState {
        let state = crate::create_app_state();
        {
            let mut grid = state.grid.write(&crate::document_effect::test_seed_effect()).unwrap();
            grid.set_cell(0, 0, cell_text("Region"));
            grid.set_cell(0, 1, cell_text("Revenue"));
            for i in 0..10u32 {
                grid.set_cell(i + 1, 0, cell_text(&format!("R{:02}", i + 1)));
                grid.set_cell(i + 1, 1, cell_number(100.0 + 7.0 * i as f64));
            }
        }
        state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
            id: "pivot-test".to_string(),
            region_type: "pivot".to_string(),
            owner_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            sheet_index: 0,
            start_row: 6,
            start_col: 0,
            end_row: 10,
            end_col: 1,
        });
        state
    }

    fn request_for(start_row: u32, start_col: u32, end_row: u32, end_col: u32, expand: bool) -> RangeInsightsRequest {
        RangeInsightsRequest {
            sheet_index: 0,
            start_row,
            start_col,
            end_row,
            end_col,
            expand_to_region: expand,
        }
    }

    #[test]
    fn analysing_a_pivots_cells_is_refused_by_the_command_itself() {
        let state = state_with_a_pivot_below_a_block();
        let err = analyze_range_impl(&state, &request_for(6, 0, 10, 1, false)).unwrap_err();
        assert_eq!(err, PIVOT_RANGE_REFUSAL);
    }

    // The case a pre-check alone misses: the user clicks ONE cell above the
    // pivot and asks for the surrounding block. `plan_region` expands into the
    // pivot, and without the second check the analysis would be of the pivot's
    // rows under the name of the cell that was clicked.
    #[test]
    fn a_single_cell_that_EXPANDS_into_a_pivot_is_refused_too() {
        let state = state_with_a_pivot_below_a_block();
        let request = request_for(2, 1, 2, 1, true);

        // The premise: without expansion that very cell is analysed happily.
        assert!(
            analyze_range_impl(&state, &request_for(2, 1, 2, 1, false)).is_ok(),
            "the cell itself is outside the pivot; only its EXPANSION reaches in"
        );

        let err = analyze_range_impl(&state, &request).unwrap_err();
        assert_eq!(err, PIVOT_RANGE_REFUSAL);
    }

    #[test]
    fn an_ordinary_range_on_a_sheet_that_has_a_pivot_is_still_analysed() {
        let state = state_with_a_pivot_below_a_block();
        let bundle = analyze_range_impl(&state, &request_for(0, 0, 5, 1, false))
            .expect("a range that does not touch the pivot must be analysed");
        assert!(
            !bundle.insights.is_empty(),
            "the positive control must actually produce facts, or it proves nothing"
        );
    }

    #[test]
    fn a_sheet_with_no_pivot_at_all_analyses_the_same_range() {
        let state = crate::create_app_state();
        {
            let mut grid = state.grid.write(&crate::document_effect::test_seed_effect()).unwrap();
            grid.set_cell(0, 0, cell_text("Region"));
            grid.set_cell(0, 1, cell_text("Revenue"));
            for i in 0..10u32 {
                grid.set_cell(i + 1, 0, cell_text(&format!("R{:02}", i + 1)));
                grid.set_cell(i + 1, 1, cell_number(100.0 + 7.0 * i as f64));
            }
        }
        assert!(analyze_range_impl(&state, &request_for(6, 0, 10, 1, false)).is_ok());
    }

    #[test]
    fn an_empty_chart_produces_a_bundle_that_says_so_rather_than_failing() {
        let request = SeriesInsightsRequest {
            title: "Nothing".to_string(),
            categories: Vec::new(),
            category_kind: "text".to_string(),
            category_values: None,
            series: Vec::new(),
            strategy: None,
        };
        let (dataset, _) = dataset_from_series(&request);
        let bundle = analyze_with_notes(&dataset, "en-US", Vec::new());
        assert!(bundle.insights.is_empty());
        assert!(!bundle.notes.is_empty(), "silence is not an answer");
    }
}
