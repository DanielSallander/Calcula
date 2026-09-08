//! FILENAME: core/insights/src/hygiene.rs
// PURPOSE: Facts about the data as DATA -- repeated rows, empty rows, error
// cells, columns that hold two kinds of thing.
// CONTEXT: These outrank most statistical findings in `thresholds.rs` for one
// reason: a column with `#REF!` in it invalidates every number computed from
// it, so an analysis that reports a clean trend and stays quiet about the
// errors underneath has actively misled the reader.

use rustc_hash::FxHashSet;

use crate::thresholds::*;
use crate::types::{Column, Dataset, Datum, FactKind};

/// Rows that exactly repeat an earlier row, across ALL columns. The example is
/// the sheet row of the first repeat, not an offset into the analysis, so the
/// user can go and look at it.
pub fn duplicate_fact(dataset: &Dataset) -> Option<FactKind> {
    let rows = dataset.row_count();
    if rows == 0 || dataset.columns.is_empty() {
        return None;
    }
    let mut seen: FxHashSet<String> = FxHashSet::default();
    let mut repeats = 0usize;
    let mut example: Option<u32> = None;
    for r in 0..rows {
        let key: Vec<String> = dataset
            .columns
            .iter()
            .map(|c| c.cells.get(r).map(Datum::key).unwrap_or_default())
            .collect();
        // An all-blank row is `BlankRows`' business; counting it here would
        // report the same rows twice under two different headings.
        if key.iter().all(|k| k.is_empty()) {
            continue;
        }
        // Joined on a unit separator: any printable delimiter could occur
        // INSIDE a cell, and two rows that differ only in where the delimiter
        // falls would then collide and be reported as duplicates.
        let joined = key.join("\u{1f}");
        if !seen.insert(joined) {
            repeats += 1;
            if example.is_none() {
                example = Some(sheet_row(dataset, r));
            }
        }
    }
    if repeats < DUPLICATE_MIN_ROWS {
        return None;
    }
    Some(FactKind::Duplicates {
        rows: repeats,
        example_row: example.unwrap_or(0),
    })
}

pub fn blank_rows_fact(dataset: &Dataset) -> Option<FactKind> {
    let rows = dataset.row_count();
    if rows == 0 || dataset.columns.is_empty() {
        return None;
    }
    let blanks = (0..rows)
        .filter(|r| {
            dataset
                .columns
                .iter()
                .all(|c| c.cells.get(*r).map(Datum::is_blank).unwrap_or(true))
        })
        .count();
    if blanks == 0 {
        return None;
    }
    Some(FactKind::BlankRows { rows: blanks })
}

pub fn error_fact(column: &Column) -> Option<FactKind> {
    let count = column.counts().error;
    if count == 0 {
        return None;
    }
    Some(FactKind::Errors {
        count,
        subject: column.subject(),
        example: column.first_error().unwrap_or("#VALUE!").to_string(),
    })
}

/// A column carrying both numbers and text in quantity. One stray label in a
/// numeric column is a typo, not a mixed type, which is what
/// `MIXED_TYPES_MIN_MINORITY_SHARE` is protecting against -- and reporting the
/// typo as a "mixed type" would send the user looking for a schema problem that
/// is not there.
pub fn mixed_types_fact(column: &Column) -> Option<FactKind> {
    let c = column.counts();
    let populated = c.number + c.text + c.boolean + c.error;
    if populated == 0 || c.number == 0 || c.text == 0 {
        return None;
    }
    let number_share = c.number as f64 / populated as f64;
    let text_share = c.text as f64 / populated as f64;
    if number_share.min(text_share) < MIXED_TYPES_MIN_MINORITY_SHARE {
        return None;
    }
    Some(FactKind::MixedTypes {
        subject: column.subject(),
        number_share,
        text_share,
    })
}

fn sheet_row(dataset: &Dataset, index: usize) -> u32 {
    dataset
        .row_origins
        .get(index)
        .copied()
        // 1-based fallback for a dataset that was built without sheet origins
        // (a model query, say). Zero would look like row 1 of the sheet.
        .unwrap_or(index as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RangeRef, SourceRef};

    fn dataset(columns: Vec<Vec<Datum>>, origins: Vec<u32>) -> Dataset {
        let cols = columns
            .into_iter()
            .enumerate()
            .map(|(i, cells)| Column {
                name: format!("C{i}"),
                sheet: "S".into(),
                range: RangeRef::new("S", 1, i as u32, 1 + cells.len() as u32, i as u32),
                cells,
            })
            .collect();
        Dataset {
            source: SourceRef::default(),
            has_header: true,
            row_origins: origins,
            columns: cols,
        }
    }

    fn t(s: &str) -> Datum {
        Datum::Text(s.to_string())
    }

    fn n(v: f64) -> Datum {
        Datum::Number(v)
    }

    #[test]
    fn repeated_rows_are_counted_and_the_example_points_at_a_sheet_row() {
        let ds = dataset(
            vec![
                vec![t("A"), t("B"), t("A"), t("A")],
                vec![n(1.0), n(2.0), n(1.0), n(1.0)],
            ],
            vec![10, 11, 12, 13],
        );
        match duplicate_fact(&ds).expect("two repeats must be reported") {
            FactKind::Duplicates { rows, example_row } => {
                assert_eq!(rows, 2);
                assert_eq!(example_row, 12, "must be the sheet row, not the offset");
            }
            other => panic!("expected duplicates, got {other:?}"),
        }
    }

    #[test]
    fn one_repeated_row_is_below_the_bar() {
        let ds = dataset(
            vec![vec![t("A"), t("B"), t("A")], vec![n(1.0), n(2.0), n(1.0)]],
            vec![1, 2, 3],
        );
        assert!(duplicate_fact(&ds).is_none());
    }

    #[test]
    fn a_blank_row_is_reported_once_and_never_also_as_a_duplicate() {
        let ds = dataset(
            vec![
                vec![t("A"), Datum::Blank, Datum::Blank, t("B")],
                vec![n(1.0), Datum::Blank, Datum::Blank, n(2.0)],
            ],
            vec![1, 2, 3, 4],
        );
        match blank_rows_fact(&ds).expect("two blank rows") {
            FactKind::BlankRows { rows } => assert_eq!(rows, 2),
            other => panic!("expected blank rows, got {other:?}"),
        }
        assert!(
            duplicate_fact(&ds).is_none(),
            "the two blank rows must not also be counted as a repeat"
        );
    }

    #[test]
    fn numbers_that_are_close_but_not_equal_are_not_duplicates() {
        // `Datum::key` uses the exact f64 debug form for this reason.
        let ds = dataset(
            vec![vec![n(1.0), n(1.0000000000000002), n(1.0), n(1.0)]],
            vec![1, 2, 3, 4],
        );
        match duplicate_fact(&ds).expect("rows 3 and 4 repeat row 1") {
            FactKind::Duplicates { rows, .. } => assert_eq!(rows, 2),
            other => panic!("expected duplicates, got {other:?}"),
        }
    }

    #[test]
    fn an_error_cell_is_reported_with_the_literal_the_user_sees() {
        let col = Column {
            name: "Margin".into(),
            sheet: "S".into(),
            range: RangeRef::new("S", 1, 0, 3, 0),
            cells: vec![n(1.0), Datum::Error("#DIV/0!".into()), n(3.0)],
        };
        match error_fact(&col).expect("one error") {
            FactKind::Errors { count, example, .. } => {
                assert_eq!(count, 1);
                assert_eq!(example, "#DIV/0!");
            }
            other => panic!("expected errors, got {other:?}"),
        }
    }

    #[test]
    fn one_stray_label_in_a_numeric_column_is_not_a_mixed_type() {
        let mut cells: Vec<Datum> = (0..20).map(|i| n(i as f64)).collect();
        cells.push(t("N/A"));
        let col = Column {
            name: "Units".into(),
            sheet: "S".into(),
            range: RangeRef::new("S", 1, 0, 21, 0),
            cells,
        };
        assert!(mixed_types_fact(&col).is_none());

        // Positive control: a genuinely half-and-half column IS reported.
        let mut half: Vec<Datum> = (0..10).map(|i| n(i as f64)).collect();
        half.extend((0..10).map(|i| t(&format!("L{i}"))));
        let mixed = Column {
            name: "Units".into(),
            sheet: "S".into(),
            range: RangeRef::new("S", 1, 0, 21, 0),
            cells: half,
        };
        match mixed_types_fact(&mixed).expect("half and half is mixed") {
            FactKind::MixedTypes {
                number_share,
                text_share,
                ..
            } => {
                assert!((number_share - 0.5).abs() < 1e-9);
                assert!((text_share - 0.5).abs() < 1e-9);
            }
            other => panic!("expected mixed types, got {other:?}"),
        }
    }
}
