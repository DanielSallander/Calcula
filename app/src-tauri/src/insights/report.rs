//! FILENAME: app/src-tauri/src/insights/report.rs
// PURPOSE: Write the run down: one row per measure, on a new sheet, in the
//          workbook the reader already has open.
// CONTEXT: A pane that disappears when you click elsewhere is not a report. The
//          value of the model-aware path is that the SAME numbers can be handed
//          to someone who was not there — pasted into a deck, mailed, published
//          in a `.calp` — and a sheet is the form of that in this product.
//
//          TWO PROPERTIES ARE LOAD-BEARING.
//
//          (1) THE REPORT IS DERIVED, NEVER AUTHORED. `build_report` is a pure
//          function of a `ModelRun`, so the sheet and the insights pane cannot
//          disagree: there is one set of numbers and two renderings of it. A
//          hand-assembled second pass over the observations would drift the
//          first time a gate changed, and the sheet — the artefact that OUTLIVES
//          the session — would be the copy that was wrong.
//
//          (2) THE NUMBER FORMATS COME FROM THE MODEL. A measure carries a
//          `format_string`; writing 0.3812 into a cell with General format and
//          calling it "Margin %" is how a report becomes untrustworthy. The
//          format travels with the value into the style registry, once per
//          distinct format, and the percentage column gets a percentage format
//          rather than a number that happens to look like one.
//
//          The sheet is created through `sheets::add_sheet_inner`, which owns
//          every per-sheet store, the user/object-sheet partition and the
//          Excel-parity undo invalidation. Hand-rolling a sheet append here
//          would be a second copy of a seventeen-store recipe, and the copy
//          would go stale on the owner's first change.

use serde::{Deserialize, Serialize};

use engine::{CellStyle, LocaleSettings, NumberFormat};
use insights::narrate::number;

use super::model::{Favourability, ModelRun};

/// The sheet name the report is created under, before de-duplication.
pub const REPORT_SHEET_BASE_NAME: &str = "Insights Report";

/// Columns of the report, in order. Hand-maintained beside `row_for`, and
/// asserted equal in length by `the_report_has_one_cell_per_declared_column`.
pub const REPORT_COLUMNS: &[&str] = &[
    "Measure",
    "Period",
    "Value",
    "Prior period",
    "Prior value",
    "Change",
    "Change %",
    "Target",
    "Status",
    "Driver",
];

/// One cell of the report, carrying the FORMAT its value needs rather than a
/// pre-rendered string. A number written as text cannot be charted, summed or
/// re-formatted by the reader, and that is most of what a spreadsheet is for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cell", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ReportCell {
    Blank,
    Text {
        value: String,
    },
    Number {
        value: f64,
        /// The measure's own `format_string`, verbatim. `None` leaves the cell
        /// General rather than inventing a format the model never declared.
        format: Option<String>,
    },
    /// A fraction shown as a percentage. Distinct from `Number` because the
    /// value stored is 0.12 and the reader must see 12%.
    Percent {
        value: f64,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportGrid {
    pub title: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<ReportCell>>,
    /// Everything the run could not do, written into the sheet under the table.
    /// A note that only ever appeared in a pane the reader closed is a note that
    /// was never delivered.
    pub notes: Vec<String>,
}

impl ReportGrid {
    /// Rows the sheet will actually occupy: title, blank, header, data, and the
    /// notes block when there is one.
    pub fn row_count(&self) -> usize {
        let notes = if self.notes.is_empty() {
            0
        } else {
            self.notes.len() + 2
        };
        3 + self.rows.len() + notes
    }

    pub fn col_count(&self) -> usize {
        self.headers.len()
    }
}

fn favourability_word(f: Option<Favourability>) -> &'static str {
    match f {
        Some(Favourability::Better) => "Better",
        Some(Favourability::Worse) => "Worse",
        Some(Favourability::Neutral) => "Flat",
        // A withheld direction says so IN THE CELL. An empty status cell reads
        // as "nothing happened", which is the opposite of what it means.
        None => "No claim",
    }
}

fn number_cell(value: Option<f64>, format: &Option<String>) -> ReportCell {
    match value {
        Some(v) => ReportCell::Number {
            value: v,
            format: format.clone(),
        },
        None => ReportCell::Blank,
    }
}

/// Derive the report from a run. Pure, total, and deterministic.
///
/// Row order is the business's own: declared priority first (lowest number is
/// most important), then everything else by name. Two runs over the same
/// numbers therefore produce the same sheet, which is what makes a saved report
/// diffable against the next one.
pub fn build_report(run: &ModelRun, locale: &LocaleSettings) -> ReportGrid {
    let mut ordered: Vec<&super::model::MeasureRun> = run.measures.iter().collect();
    ordered.sort_by(|a, b| {
        match (a.priority, b.priority) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| a.measure.cmp(&b.measure))
    });

    let rows = ordered
        .into_iter()
        .map(|m| {
            let status = match (&m.status, m.target) {
                // A KPI band is a stronger statement than a favourability, so
                // it wins the cell when the model has one.
                (Some(band), _) => band.clone(),
                _ => favourability_word(m.favourability).to_string(),
            };
            vec![
                ReportCell::Text {
                    value: m.measure.clone(),
                },
                ReportCell::Text {
                    value: m.period_label.clone(),
                },
                number_cell(m.value, &m.format_string),
                ReportCell::Text {
                    value: m.prior_label.clone(),
                },
                number_cell(m.prior_value, &m.format_string),
                number_cell(m.delta, &m.format_string),
                match m.pct {
                    Some(p) => ReportCell::Percent { value: p },
                    None => ReportCell::Blank,
                },
                number_cell(m.target, &m.format_string),
                ReportCell::Text { value: status },
                match &m.driver {
                    Some(d) => ReportCell::Text { value: d.clone() },
                    None => ReportCell::Blank,
                },
            ]
        })
        .collect();

    // The title states WHAT was analysed and in which number formatting, so a
    // sheet that outlives this session still says where it came from.
    let title = format!(
        "{} — insights ({})",
        run.model_label,
        if run.locale_id.is_empty() {
            locale.locale_id.clone()
        } else {
            run.locale_id.clone()
        }
    );

    ReportGrid {
        title,
        headers: REPORT_COLUMNS.iter().map(|c| c.to_string()).collect(),
        rows,
        notes: run.notes.clone(),
    }
}

/// The report as text, for a chat tool and for Copy as text.
pub fn report_markdown(grid: &ReportGrid, locale: &LocaleSettings) -> String {
    let render = |cell: &ReportCell| -> String {
        match cell {
            ReportCell::Blank => String::new(),
            ReportCell::Text { value } => value.clone(),
            ReportCell::Number { value, .. } => number::num(*value, locale),
            ReportCell::Percent { value } => number::signed_pct(*value, locale),
        }
    };
    let mut out = format!("## {}\n\n", grid.title);
    out.push_str(&format!("| {} |\n", grid.headers.join(" | ")));
    out.push_str(&format!(
        "|{}|\n",
        grid.headers
            .iter()
            .map(|_| " --- ")
            .collect::<Vec<_>>()
            .join("|")
    ));
    for row in &grid.rows {
        let cells: Vec<String> = row.iter().map(render).collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    if !grid.notes.is_empty() {
        out.push_str("\n### Notes\n\n");
        for note in &grid.notes {
            out.push_str(&format!("- {}\n", note));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Writing it into the workbook
// ---------------------------------------------------------------------------

/// A style index per distinct number format, minted once and reused.
///
/// `get_or_create` already deduplicates, but going through the registry once
/// per cell would take the registry's write lock ten times a row for a format
/// that never changes within a column.
struct StyleCache<'a> {
    registry: &'a mut engine::StyleRegistry,
    header: usize,
    title: usize,
    percent: usize,
    by_format: std::collections::BTreeMap<String, usize>,
    general: usize,
}

impl<'a> StyleCache<'a> {
    fn new(registry: &'a mut engine::StyleRegistry) -> Self {
        let title = registry.get_or_create(CellStyle::new().with_bold(true));
        let header = registry.get_or_create(CellStyle::new().with_bold(true));
        let percent = registry.get_or_create(
            CellStyle::new().with_number_format(NumberFormat::Percentage { decimal_places: 1 }),
        );
        let general = registry.get_or_create(CellStyle::new());
        Self {
            registry,
            header,
            title,
            percent,
            by_format: std::collections::BTreeMap::new(),
            general,
        }
    }

    fn for_format(&mut self, format: &Option<String>) -> usize {
        let Some(f) = format.as_ref().filter(|f| !f.trim().is_empty()) else {
            return self.general;
        };
        if let Some(index) = self.by_format.get(f) {
            return *index;
        }
        // The model's format string is an OPAQUE host contract (see
        // `Measure::with_format_string`): it is passed through as a custom
        // format rather than parsed into a variant here, because the parse
        // would be a second interpretation of a grammar the engine already
        // declares it does not own.
        let index = self.registry.get_or_create(
            CellStyle::new().with_number_format(NumberFormat::Custom { format: f.clone() }),
        );
        self.by_format.insert(f.clone(), index);
        index
    }
}

/// Paint the report into a fresh grid.
///
/// Separated from the command so it can be tested without Tauri state: the
/// caller owns the sheet and the locks, this owns the layout.
pub fn paint(grid: &mut engine::Grid, report: &ReportGrid, registry: &mut engine::StyleRegistry) {
    let mut styles = StyleCache::new(registry);

    let mut title = engine::Cell::new_text(report.title.clone());
    title.style_index = styles.title;
    grid.set_cell(0, 0, title);

    for (c, header) in report.headers.iter().enumerate() {
        let mut cell = engine::Cell::new_text(header.clone());
        cell.style_index = styles.header;
        grid.set_cell(2, c as u32, cell);
    }

    for (r, row) in report.rows.iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            let cell = match value {
                ReportCell::Blank => continue,
                ReportCell::Text { value } => engine::Cell::new_text(value.clone()),
                ReportCell::Number { value, format } => {
                    let mut cell = engine::Cell::new_number(*value);
                    cell.style_index = styles.for_format(format);
                    cell
                }
                ReportCell::Percent { value } => {
                    let mut cell = engine::Cell::new_number(*value);
                    cell.style_index = styles.percent;
                    cell
                }
            };
            grid.set_cell((r + 3) as u32, c as u32, cell);
        }
    }

    if report.notes.is_empty() {
        return;
    }
    let notes_row = 3 + report.rows.len() + 1;
    let mut heading = engine::Cell::new_text("Notes".to_string());
    heading.style_index = styles.header;
    grid.set_cell(notes_row as u32, 0, heading);
    for (i, note) in report.notes.iter().enumerate() {
        grid.set_cell(
            (notes_row + 1 + i) as u32,
            0,
            engine::Cell::new_text(note.clone()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::model::{MeasureRun, ModelRun};

    fn locale() -> LocaleSettings {
        LocaleSettings::from_locale_id("en-US")
    }

    fn measure_run(name: &str, priority: Option<u32>) -> MeasureRun {
        MeasureRun {
            measure: name.to_string(),
            format_string: Some("#,##0.00".to_string()),
            period_label: "2026-09".to_string(),
            value: Some(171.0),
            prior_label: "2026-08".to_string(),
            prior_value: Some(160.0),
            delta: Some(11.0),
            pct: Some(0.06875),
            target: Some(150.0),
            status: None,
            favourability: Some(Favourability::Better),
            driver: None,
            priority,
        }
    }

    fn run_with(measures: Vec<MeasureRun>, notes: Vec<String>) -> ModelRun {
        ModelRun {
            model_label: "Sales model".to_string(),
            locale_id: "en-US".to_string(),
            measures,
            facts: Vec::new(),
            dropped: 0,
            notes,
        }
    }

    #[test]
    fn the_report_has_one_cell_per_declared_column() {
        let report = build_report(&run_with(vec![measure_run("Revenue", None)], vec![]), &locale());
        assert_eq!(report.headers.len(), REPORT_COLUMNS.len());
        for row in &report.rows {
            assert_eq!(
                row.len(),
                REPORT_COLUMNS.len(),
                "a row that is short by one silently shifts every column after it"
            );
        }
    }

    #[test]
    fn priority_measures_come_first_and_the_rest_are_ordered_by_name() {
        let report = build_report(
            &run_with(
                vec![
                    measure_run("Zulu", None),
                    measure_run("Alpha", None),
                    measure_run("Cost", Some(1)),
                    measure_run("Revenue", Some(0)),
                ],
                vec![],
            ),
            &locale(),
        );
        let names: Vec<String> = report
            .rows
            .iter()
            .map(|r| match &r[0] {
                ReportCell::Text { value } => value.clone(),
                other => panic!("column 0 is the measure name, got {:?}", other),
            })
            .collect();
        assert_eq!(names, vec!["Revenue", "Cost", "Alpha", "Zulu"]);
    }

    #[test]
    fn a_measures_number_format_travels_with_its_value() {
        let report = build_report(&run_with(vec![measure_run("Revenue", None)], vec![]), &locale());
        for column in [2usize, 4, 5, 7] {
            match &report.rows[0][column] {
                ReportCell::Number { format, .. } => assert_eq!(
                    format.as_deref(),
                    Some("#,##0.00"),
                    "column {} lost the measure's format",
                    column
                ),
                other => panic!("column {} must be a number, got {:?}", column, other),
            }
        }
        // The percentage column is a FRACTION shown as a percent, not the
        // measure's own currency format applied to 0.06875.
        assert_eq!(report.rows[0][6], ReportCell::Percent { value: 0.06875 });
    }

    #[test]
    fn a_withheld_favourability_says_so_in_the_status_cell() {
        let mut m = measure_run("Returns", None);
        m.favourability = None;
        m.status = None;
        let report = build_report(&run_with(vec![m], vec![]), &locale());
        assert_eq!(
            report.rows[0][8],
            ReportCell::Text {
                value: "No claim".to_string()
            },
            "an empty status cell would read as 'nothing happened'"
        );
    }

    #[test]
    fn a_kpi_band_wins_the_status_cell_over_a_favourability() {
        let mut m = measure_run("Revenue", None);
        m.status = Some("OnTrack".to_string());
        let report = build_report(&run_with(vec![m], vec![]), &locale());
        assert_eq!(
            report.rows[0][8],
            ReportCell::Text {
                value: "OnTrack".to_string()
            }
        );
    }

    #[test]
    fn a_measure_with_no_comparison_leaves_blanks_rather_than_zeros() {
        let mut m = measure_run("New measure", None);
        m.prior_value = None;
        m.delta = None;
        m.pct = None;
        m.target = None;
        let report = build_report(&run_with(vec![m], vec![]), &locale());
        assert_eq!(report.rows[0][4], ReportCell::Blank);
        assert_eq!(report.rows[0][5], ReportCell::Blank);
        assert_eq!(report.rows[0][6], ReportCell::Blank);
        assert_eq!(report.rows[0][7], ReportCell::Blank);
    }

    #[test]
    fn the_notes_reach_the_sheet_and_not_only_the_pane() {
        let report = build_report(
            &run_with(
                vec![measure_run("Revenue", None)],
                vec!["Supplier[Country] is not directly related to Sales.".to_string()],
            ),
            &locale(),
        );
        assert_eq!(report.notes.len(), 1);

        let mut grid = engine::Grid::new();
        let mut registry = engine::StyleRegistry::new();
        paint(&mut grid, &report, &mut registry);

        // title, blank, header, one data row, blank, "Notes", one note.
        let notes_row = 3 + 1 + 1;
        assert_eq!(
            grid.get_cell(notes_row as u32, 0).map(|c| c.display_value()),
            Some("Notes".to_string())
        );
        assert!(grid
            .get_cell((notes_row + 1) as u32, 0)
            .map(|c| c.display_value())
            .unwrap_or_default()
            .contains("Supplier[Country]"));
        assert_eq!(report.row_count(), notes_row + 2);
    }

    #[test]
    fn a_painted_value_is_a_number_carrying_the_models_format_not_a_string() {
        let report = build_report(&run_with(vec![measure_run("Revenue", None)], vec![]), &locale());
        let mut grid = engine::Grid::new();
        let mut registry = engine::StyleRegistry::new();
        paint(&mut grid, &report, &mut registry);

        let cell = grid.get_cell(3, 2).expect("the first value cell");
        assert_eq!(cell.value, engine::CellValue::Number(171.0));
        assert_eq!(
            registry.get(cell.style_index).number_format,
            NumberFormat::Custom {
                format: "#,##0.00".to_string()
            },
            "a number written under General format is how a report stops being trusted"
        );

        let pct = grid.get_cell(3, 6).expect("the change-% cell");
        assert_eq!(pct.value, engine::CellValue::Number(0.06875));
        assert_eq!(
            registry.get(pct.style_index).number_format,
            NumberFormat::Percentage { decimal_places: 1 }
        );
    }

    #[test]
    fn two_reports_over_the_same_run_are_identical() {
        let run = run_with(
            vec![measure_run("Revenue", Some(0)), measure_run("Cost", None)],
            vec!["a note".to_string()],
        );
        let a = serde_json::to_string(&build_report(&run, &locale())).expect("serializes");
        let b = serde_json::to_string(&build_report(&run, &locale())).expect("serializes");
        assert_eq!(a, b);
    }

    #[test]
    fn the_markdown_rendering_keeps_the_column_count() {
        let report = build_report(
            &run_with(vec![measure_run("Revenue", None)], vec!["a note".to_string()]),
            &locale(),
        );
        let md = report_markdown(&report, &locale());
        let header = md
            .lines()
            .find(|l| l.starts_with("| Measure"))
            .expect("a header row");
        assert_eq!(header.matches('|').count(), REPORT_COLUMNS.len() + 1);
        assert!(md.contains("### Notes"));
    }
}
