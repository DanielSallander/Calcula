//! FILENAME: app/src-tauri/src/insights/region.rs
// PURPOSE: Decide WHICH cells "what is going on in this range" actually looks
//          at -- expand a lone cell to its block, find the header, drop the rows
//          the user hid, sample a region too big to read whole -- and lift the
//          survivors into the `Dataset` the insights crate consumes.
// CONTEXT: Four decisions live here, and each one is a way to be wrong quietly.
//
//          ONE REGION WALKER. Expansion delegates to
//          `engine::navigation::current_region`, the same function behind
//          Ctrl+Shift+* and `get_current_region`. A second walker would agree
//          with the first on every rectangular block and disagree exactly on the
//          ragged data where the user most needs the two to match.
//
//          HIDDEN ROWS ARE NOT DATA. Somebody hid them to keep them out of the
//          report; summarising them back into the report is the same mistake
//          wearing a different hat. The set comes from
//          `commands::nav::collect_hidden_rows_for_sheet`, which is the union of
//          all four authorities (AutoFilter, advanced filter, collapsed outline,
//          hand-hidden) -- not from any one of them, because "filtered out" and
//          "hidden by hand" are equally out of the picture for a summary. How
//          many were dropped is stated in `notes`; a silently smaller answer is
//          indistinguishable from a bug.
//
//          A DATE IS A NUMBER, AND ONLY THE STYLE KNOWS. Calcula has no date
//          value type, so `45000` and 2023-03-15 are the same `CellValue`. Left
//          alone, a date column reports a beautiful linear trend of "+1 per row"
//          and steals the "first numeric column" slot from the actual measure.
//          A date-FORMATTED number therefore enters the dataset as its formatted
//          TEXT -- which also makes it the label column, so a finding reads
//          "peaks in 2026-03" instead of "peaks at row 7". A bare 45000 with a
//          General format is left as the number it is. The test is
//          `NumberFormat::Date`/`Time` on the cell's EFFECTIVE style, the same
//          test `ai::formula_context` makes for the same reason.
//
//          SAMPLING IS ANNOUNCED. Above `REGION_MAX_ROWS` the analysis reads an
//          evenly strided sample and says so. Truncating to the first N rows
//          would be faster and would describe January.

use std::collections::HashSet;

use engine::coord::index_to_col;
use engine::grid::Grid;
use engine::navigation;
use engine::style::{CellStyle, NumberFormat, StyleRegistry};
use engine::LocaleSettings;
use insights::types::{
    datum_from_cell, Column, Dataset, Datum, HeaderMode, RangeRef, SourceRef,
};

/// The most data rows a single analysis reads.
///
/// 5,000, and the number is a statistics decision rather than a performance
/// one: every fact this crate produces (mean, median, IQR fences, a slope, an
/// autocorrelation, a change point) has long since converged by then, so the
/// 5,001st row changes the sentence in no visible way. It is also comfortably
/// cheap -- 5,000 rows across a few dozen columns is a few hundred thousand
/// `Datum`s, well inside the budget of a pane that must feel instant. Reading a
/// million-row sheet whole would buy nothing except a frozen window.
pub const REGION_MAX_ROWS: usize = 5_000;

/// What the analysis will actually read: a rectangle, a header decision, and
/// the exact sheet rows that survived hiding and sampling.
///
/// Separated from the extraction so the choice can be tested against a bare
/// `Grid` and a hidden-row set, with no `AppState` and no Tauri anywhere.
#[derive(Debug, Clone, PartialEq)]
pub struct RegionPlan {
    /// The resolved rectangle, after expansion and after clamping to the used
    /// range. Carries the sheet NAME, because that is what an A1 label needs.
    pub range: RangeRef,
    pub header: HeaderMode,
    /// The sheet row holding the column names, when there is one.
    pub header_row: Option<u32>,
    /// The data rows to read, in sheet order. Hidden rows are already gone and
    /// sampling has already been applied, so this list IS the analysis.
    pub rows: Vec<u32>,
    /// Everything that was decided on the user's behalf, in their words.
    pub notes: Vec<String>,
}

impl RegionPlan {
    pub fn has_header(&self) -> bool {
        matches!(self.header, HeaderMode::Yes)
    }
}

/// Choose the cells to analyse.
///
/// `expand_to_region` only means anything for a SINGLE cell: a user who dragged
/// out a rectangle has already said what they meant, and quietly analysing the
/// block around it would answer a question they did not ask.
pub fn plan_region(
    grid: &Grid,
    sheet: &str,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    expand_to_region: bool,
    hidden_rows: &HashSet<u32>,
) -> RegionPlan {
    let (mut sr, mut er) = (start_row.min(end_row), start_row.max(end_row));
    let (mut sc, mut ec) = (start_col.min(end_col), start_col.max(end_col));

    if expand_to_region && sr == er && sc == ec {
        // A lone cell in empty space expands to nothing; keep the cell itself
        // so the caller gets an "this range holds no data" bundle rather than
        // an error.
        if let Some((r0, c0, r1, c1)) = navigation::current_region(grid, sr, sc) {
            sr = r0;
            sc = c0;
            er = r1;
            ec = c1;
        }
    }

    // Clamp to the used range. A whole-column selection arrives as 1,048,575
    // rows of which all but a handful are empty, and walking them would cost
    // seconds to learn nothing. `.max(sr)` keeps a deliberate single-cell
    // request beyond the used range intact instead of inverting the rectangle.
    er = er.min(grid.max_row.max(sr));
    ec = ec.min(grid.max_col.max(sc));

    let range = RangeRef::new(sheet, sr, sc, er, ec);

    let mut rows: Vec<u32> = (sr..=er).filter(|r| !hidden_rows.contains(r)).collect();
    let hidden_count = (er - sr + 1) as usize - rows.len();

    let header_row = if rows.len() >= 2 && detect_header(grid, rows[0], rows[1], sc, ec) {
        Some(rows.remove(0))
    } else {
        None
    };

    let mut notes: Vec<String> = Vec::new();
    if hidden_count > 0 {
        notes.push(format!(
            "{} hidden {} excluded from this analysis.",
            hidden_count,
            if hidden_count == 1 {
                "row was"
            } else {
                "rows were"
            }
        ));
    }

    if rows.len() > REGION_MAX_ROWS {
        let total = rows.len();
        // Ceiling division: a stride that rounds down would keep MORE than the
        // cap and defeat the point of having one.
        let stride = total.div_ceil(REGION_MAX_ROWS);
        rows = rows.into_iter().step_by(stride).collect();
        notes.push(format!(
            "Sampled {} of {} data rows -- one row in every {} -- because the range is larger than {} rows.",
            rows.len(),
            total,
            stride,
            REGION_MAX_ROWS
        ));
    }

    RegionPlan {
        range,
        header: if header_row.is_some() {
            HeaderMode::Yes
        } else {
            HeaderMode::No
        },
        header_row,
        rows,
        notes,
    }
}

/// Read the planned cells into a `Dataset`.
///
/// Column ranges span the FIRST and LAST row actually read, which under
/// sampling is the whole block rather than the sampled rows: the evidence a
/// user clicks should select the data the finding is about, and the sample is
/// an implementation detail of how it was measured.
pub fn extract_dataset(
    grid: &Grid,
    styles: &StyleRegistry,
    locale: &LocaleSettings,
    sheet: &str,
    plan: &RegionPlan,
) -> Dataset {
    let first = plan.rows.first().copied().unwrap_or(plan.range.start_row);
    let last = plan.rows.last().copied().unwrap_or(first);

    let mut columns = Vec::new();
    for col in plan.range.start_col..=plan.range.end_col {
        let name = match plan.header_row {
            Some(header_row) => {
                let raw = datum_at(grid, styles, locale, header_row, col).display();
                if raw.trim().is_empty() {
                    index_to_col(col)
                } else {
                    raw
                }
            }
            None => index_to_col(col),
        };
        let cells: Vec<Datum> = plan
            .rows
            .iter()
            .map(|&row| datum_at(grid, styles, locale, row, col))
            .collect();
        columns.push(Column {
            name,
            sheet: sheet.to_string(),
            range: RangeRef::new(sheet, first, col, last, col),
            cells,
        });
    }

    Dataset {
        source: SourceRef {
            label: plan.range.to_a1(),
            sheet: sheet.to_string(),
            range: Some(plan.range.clone()),
        },
        has_header: plan.has_header(),
        row_origins: plan.rows.clone(),
        columns,
    }
}

/// A date is a NUMBER whose effective style says it is a date. Asking the value
/// answers "number" for every date in the workbook.
fn style_says_date(style: &CellStyle) -> bool {
    matches!(
        style.number_format,
        NumberFormat::Date { .. } | NumberFormat::Time { .. }
    )
}

/// One cell, as the analysis sees it: the crate's own conversion, except that a
/// date-formatted number arrives as the text a reader would see.
fn datum_at(
    grid: &Grid,
    styles: &StyleRegistry,
    locale: &LocaleSettings,
    row: u32,
    col: u32,
) -> Datum {
    let Some(cell) = grid.get_cell(row, col) else {
        return Datum::Blank;
    };
    let datum = datum_from_cell(cell);
    if matches!(datum, Datum::Number(_)) {
        let style = styles.get(grid.effective_style_index(row, col));
        if style_says_date(style) {
            let text = crate::format_cell_value(&cell.value, style, locale);
            if text.trim().is_empty() {
                return Datum::Blank;
            }
            return Datum::Text(text);
        }
    }
    datum
}

/// A first row is a header when it is text and the row below it is not,
/// evaluated per column: text under text proves nothing, because a label column
/// looks exactly like that.
///
/// Deliberately reads the RAW datum rather than `datum_at`: a date column's
/// first data row is a number here, which is the fact that distinguishes it
/// from its own header. Run it through the date-to-text conversion first and a
/// two-column date/number table would stop being seen to have a header at all.
fn detect_header(grid: &Grid, top: u32, next: u32, start_col: u32, end_col: u32) -> bool {
    let mut header_texts = 0usize;
    let mut body_non_text = 0usize;
    for col in start_col..=end_col {
        let head = grid
            .get_cell(top, col)
            .map(datum_from_cell)
            .unwrap_or(Datum::Blank);
        let body = grid
            .get_cell(next, col)
            .map(datum_from_cell)
            .unwrap_or(Datum::Blank);
        match head {
            Datum::Text(_) => header_texts += 1,
            Datum::Blank => {}
            // A number, a boolean or an error in the top row is data.
            _ => return false,
        }
        if !matches!(body, Datum::Text(_) | Datum::Blank) {
            body_non_text += 1;
        }
    }
    header_texts > 0 && body_non_text > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::cell::{Cell, CellValue};

    fn text(s: &str) -> Cell {
        Cell {
            ast: None,
            value: CellValue::Text(s.to_string()),
            style_index: 0,
            rich_text: None,
        }
    }

    fn number(n: f64) -> Cell {
        Cell {
            ast: None,
            value: CellValue::Number(n),
            style_index: 0,
            rich_text: None,
        }
    }

    fn styled_number(n: f64, style_index: usize) -> Cell {
        Cell {
            ast: None,
            value: CellValue::Number(n),
            style_index,
            rich_text: None,
        }
    }

    fn date_style(styles: &mut StyleRegistry) -> usize {
        styles.get_or_create(CellStyle {
            number_format: NumberFormat::Date {
                format: "YYYY-MM-DD".to_string(),
            },
            ..Default::default()
        })
    }

    /// `Month | Revenue` with a header row and 12 data rows starting at row 1.
    fn sales_grid() -> Grid {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("Month"));
        grid.set_cell(0, 1, text("Revenue"));
        for i in 0..12u32 {
            grid.set_cell(i + 1, 0, text(&format!("M{:02}", i + 1)));
            grid.set_cell(i + 1, 1, number(100.0 + 5.0 * i as f64));
        }
        grid
    }

    fn nothing_hidden() -> HashSet<u32> {
        HashSet::new()
    }

    fn plan(grid: &Grid, rect: (u32, u32, u32, u32), expand: bool) -> RegionPlan {
        plan_region(
            grid,
            "Sheet1",
            rect.0,
            rect.1,
            rect.2,
            rect.3,
            expand,
            &nothing_hidden(),
        )
    }

    #[test]
    fn a_single_cell_expands_to_its_block_and_a_dragged_rectangle_does_not() {
        let grid = sales_grid();

        let expanded = plan(&grid, (5, 1, 5, 1), true);
        assert_eq!(expanded.range, RangeRef::new("Sheet1", 0, 0, 12, 1));

        // The positive control's negative half, in the same data: a user who
        // dragged a rectangle asked about THAT rectangle.
        let dragged = plan(&grid, (3, 1, 6, 1), true);
        assert_eq!(dragged.range, RangeRef::new("Sheet1", 3, 1, 6, 1));

        // And expansion is opt-in even for one cell.
        let unexpanded = plan(&grid, (5, 1, 5, 1), false);
        assert_eq!(unexpanded.range, RangeRef::new("Sheet1", 5, 1, 5, 1));
    }

    #[test]
    fn an_isolated_cell_expands_to_itself_rather_than_failing() {
        let mut grid = sales_grid();
        grid.set_cell(40, 8, text("stray"));
        // A truly empty cell has no region at all.
        let empty = plan(&grid, (50, 9, 50, 9), true);
        assert_eq!(empty.range, RangeRef::new("Sheet1", 50, 9, 50, 9));
        assert!(empty.rows.contains(&50));
    }

    #[test]
    fn a_text_over_numbers_first_row_is_a_header_and_a_numbers_only_first_row_is_not() {
        let with_header = plan(&sales_grid(), (0, 0, 12, 1), false);
        assert_eq!(with_header.header, HeaderMode::Yes);
        assert_eq!(with_header.header_row, Some(0));
        assert_eq!(with_header.rows.len(), 12);
        assert_eq!(with_header.rows[0], 1);

        // The other direction, and it must be a real one: a block whose first
        // row is numbers has no header and loses no row to one.
        let mut bare = Grid::new();
        for i in 0..10u32 {
            bare.set_cell(i, 0, number(1.0 + i as f64));
            bare.set_cell(i, 1, number(20.0 + i as f64));
        }
        let without = plan(&bare, (0, 0, 9, 1), false);
        assert_eq!(without.header, HeaderMode::No);
        assert_eq!(without.header_row, None);
        assert_eq!(without.rows.len(), 10);
    }

    #[test]
    fn text_under_text_is_not_a_header_because_a_label_column_looks_identical() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("Region"));
        for i in 0..6u32 {
            grid.set_cell(i + 1, 0, text(&format!("R{}", i)));
        }
        assert_eq!(plan(&grid, (0, 0, 6, 0), false).header, HeaderMode::No);
    }

    #[test]
    fn hidden_rows_are_excluded_and_the_note_says_how_many() {
        let grid = sales_grid();
        let hidden: HashSet<u32> = [3u32, 4, 9].into_iter().collect();
        let planned = plan_region(&grid, "Sheet1", 0, 0, 12, 1, false, &hidden);

        assert_eq!(planned.rows.len(), 9, "12 data rows minus 3 hidden");
        for row in [3u32, 4, 9] {
            assert!(
                !planned.rows.contains(&row),
                "row {row} was hidden and must not be analysed"
            );
        }
        assert!(
            planned.notes.iter().any(|n| n.contains("3 hidden rows were")),
            "the count must be stated, got {:?}",
            planned.notes
        );

        // The extracted data agrees with the plan: the hidden values are gone
        // from the column, not merely absent from the row list.
        let styles = StyleRegistry::new();
        let ds = extract_dataset(
            &grid,
            &styles,
            &LocaleSettings::invariant(),
            "Sheet1",
            &planned,
        );
        let revenue = &ds.columns[1];
        assert_eq!(revenue.cells.len(), 9);
        assert!(
            !revenue.numbers().contains(&110.0),
            "row 3 held 110 and was hidden"
        );
        assert!(revenue.numbers().contains(&100.0));
    }

    #[test]
    fn a_hidden_first_row_lets_the_next_visible_row_be_the_header() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("stale title"));
        grid.set_cell(1, 0, text("Month"));
        grid.set_cell(1, 1, text("Revenue"));
        for i in 0..6u32 {
            grid.set_cell(i + 2, 0, text(&format!("M{i}")));
            grid.set_cell(i + 2, 1, number(10.0 * i as f64));
        }
        let hidden: HashSet<u32> = [0u32].into_iter().collect();
        let planned = plan_region(&grid, "Sheet1", 0, 0, 7, 1, false, &hidden);
        assert_eq!(planned.header_row, Some(1));
        assert_eq!(planned.rows, vec![2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn a_region_larger_than_the_cap_is_sampled_evenly_and_says_so() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("Value"));
        let total = (REGION_MAX_ROWS * 3 + 7) as u32;
        for i in 0..total {
            grid.set_cell(i + 1, 0, number(i as f64));
        }
        let planned = plan(&grid, (0, 0, total, 0), false);

        assert_eq!(planned.header_row, Some(0));
        assert!(
            planned.rows.len() <= REGION_MAX_ROWS,
            "{} rows survived a cap of {}",
            planned.rows.len(),
            REGION_MAX_ROWS
        );
        assert!(
            planned.rows.len() > REGION_MAX_ROWS / 2,
            "the sample must stay useful, got {} rows",
            planned.rows.len()
        );
        // Evenly strided, not the first N: the last row of the block is within
        // one stride of the last sampled row.
        let stride = (planned.rows[1] - planned.rows[0]) as usize;
        assert!(stride >= 2);
        assert!(
            (total - planned.rows[planned.rows.len() - 1]) as usize <= stride,
            "the sample stopped early and would describe only the beginning"
        );
        assert!(
            planned
                .notes
                .iter()
                .any(|n| n.contains("Sampled") && n.contains(&total.to_string())),
            "sampling must be announced with the real total, got {:?}",
            planned.notes
        );

        // Below the cap nothing is sampled and nothing is announced.
        let small = plan(&sales_grid(), (0, 0, 12, 1), false);
        assert!(small.notes.is_empty(), "{:?}", small.notes);
    }

    #[test]
    fn a_date_formatted_number_becomes_a_label_and_a_bare_number_stays_a_number() {
        // THE case this module exists to get right. Both columns hold the same
        // serial numbers; only the style differs.
        let mut styles = StyleRegistry::new();
        let dated = date_style(&mut styles);

        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("Day"));
        grid.set_cell(0, 1, text("Serial"));
        grid.set_cell(0, 2, text("Revenue"));
        for i in 0..10u32 {
            grid.set_cell(i + 1, 0, styled_number(45000.0 + i as f64, dated));
            grid.set_cell(i + 1, 1, number(45000.0 + i as f64));
            grid.set_cell(i + 1, 2, number(100.0 + 3.0 * i as f64));
        }

        let planned = plan(&grid, (0, 0, 10, 2), false);
        assert_eq!(planned.header_row, Some(0), "a date row under text is data");

        let ds = extract_dataset(
            &grid,
            &styles,
            &LocaleSettings::invariant(),
            "Sheet1",
            &planned,
        );
        assert!(
            matches!(ds.columns[0].cells[0], Datum::Text(_)),
            "a date-formatted number must arrive as its label, got {:?}",
            ds.columns[0].cells[0]
        );
        assert_eq!(
            ds.columns[1].cells[0],
            Datum::Number(45000.0),
            "a bare 45000 is not a date and must stay a number"
        );
        // And the consequence that matters: the dates become the row labels, so
        // a finding names a day instead of a row position.
        let labels = ds.labels();
        assert!(
            labels[0].contains("2023") || labels[0].contains('-'),
            "expected a formatted date label, got {:?}",
            labels[0]
        );
    }

    #[test]
    fn a_whole_column_selection_is_clamped_to_the_used_range() {
        let grid = sales_grid();
        let planned = plan(&grid, (0, 1, 1_048_575, 1), false);
        assert_eq!(planned.range.end_row, grid.max_row);
        assert!(
            planned.rows.len() <= (grid.max_row + 1) as usize,
            "the walk must not run past the data"
        );
    }

    #[test]
    fn the_extracted_dataset_names_its_columns_from_the_header_and_points_at_real_cells() {
        let grid = sales_grid();
        let planned = plan(&grid, (0, 0, 12, 1), false);
        let styles = StyleRegistry::new();
        let ds = extract_dataset(
            &grid,
            &styles,
            &LocaleSettings::invariant(),
            "Sheet1",
            &planned,
        );

        assert!(ds.has_header);
        assert_eq!(ds.columns[0].name, "Month");
        assert_eq!(ds.columns[1].name, "Revenue");
        assert_eq!(ds.columns[1].range.to_a1(), "Sheet1!B2:B13");
        assert_eq!(ds.row_origins, (1..=12).collect::<Vec<u32>>());
        assert_eq!(ds.source.label, "Sheet1!A1:B13");
    }

    #[test]
    fn a_headerless_block_names_its_columns_by_letter() {
        let mut grid = Grid::new();
        for i in 0..8u32 {
            grid.set_cell(i, 2, number(i as f64));
        }
        let planned = plan(&grid, (0, 2, 7, 2), false);
        let styles = StyleRegistry::new();
        let ds = extract_dataset(
            &grid,
            &styles,
            &LocaleSettings::invariant(),
            "Sheet1",
            &planned,
        );
        assert!(!ds.has_header);
        assert_eq!(ds.columns[0].name, "C");
        assert_eq!(ds.columns[0].cells.len(), 8);
    }

    #[test]
    fn a_gap_in_a_column_stays_a_gap_and_never_becomes_a_zero() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, text("Revenue"));
        grid.set_cell(1, 0, number(10.0));
        // row 2 deliberately left empty
        grid.set_cell(3, 0, number(30.0));
        let planned = plan(&grid, (0, 0, 3, 0), false);
        let styles = StyleRegistry::new();
        let ds = extract_dataset(
            &grid,
            &styles,
            &LocaleSettings::invariant(),
            "Sheet1",
            &planned,
        );
        assert_eq!(ds.columns[0].cells[1], Datum::Blank);
        assert_eq!(ds.columns[0].numbers(), vec![10.0, 30.0]);
    }
}
