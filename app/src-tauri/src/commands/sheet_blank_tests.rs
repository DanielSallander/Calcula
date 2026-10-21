//! FILENAME: app/src-tauri/src/commands/sheet_blank_tests.rs
//! PURPOSE: `sheet_contents` / `sheet_is_blank` against a real `AppState`:
//!          an empty sheet is blank, and each store the review named -- notes,
//!          comments, non-list validation, plain conditional formats,
//!          sheet-scoped names -- plus the cells, formats, sizes, objects and
//!          protection makes it NOT blank, on the active sheet and off it.

use super::*;

struct Book {
    state: AppState,
    pivots: crate::pivot::types::PivotState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
}

impl Book {
    fn new(sheets: usize) -> Self {
        let state = crate::create_app_state();
        let seed = crate::document_effect::test_seed_effect();
        for i in 1..sheets {
            state.grids.write(&seed).unwrap().push(engine::Grid::new());
            state.sheet_names.write(&seed).unwrap().push(format!("Sheet{}", i + 1));
            state.all_column_widths.write(&seed).unwrap().push(Default::default());
            state.all_row_heights.write(&seed).unwrap().push(Default::default());
            state.all_user_hidden_rows.write(&seed).unwrap().push(Default::default());
            state.all_user_hidden_cols.write(&seed).unwrap().push(Default::default());
            state
                .sheet_ids
                .write(&seed)
                .unwrap()
                .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < sheets {
                all.push(Default::default());
            }
        }
        Book {
            state,
            pivots: crate::pivot::types::PivotState::new(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn contents(&self, sheet: usize) -> Vec<&'static str> {
        sheet_contents(&self.state, &self.pivots, &self.slicers, &self.timelines, sheet).expect("in range")
    }
}

fn seed() -> crate::document_effect::DocumentEffect {
    crate::document_effect::test_seed_effect()
}

#[test]
fn a_new_sheet_is_blank_and_an_index_past_the_workbook_is_refused() {
    let b = Book::new(2);
    assert!(b.contents(0).is_empty(), "{:?}", b.contents(0));
    assert!(b.contents(1).is_empty(), "{:?}", b.contents(1));
    assert!(sheet_contents(&b.state, &b.pivots, &b.slicers, &b.timelines, 2).is_err());
}

/// The review's reproduction: an otherwise empty sheet holding only a note,
/// a whole-number validation rule, a plain conditional format or a
/// sheet-scoped name read as blank and was deleted with no question.
#[test]
fn the_stores_the_used_range_cannot_see_make_a_sheet_not_blank() {
    let b = Book::new(3);
    b.state.notes.write(&seed()).unwrap().entry(1).or_default().insert(
        (0, 0),
        crate::notes::Note::new(0, 0, 1, "me".into(), "a note".into()),
    );
    assert_eq!(b.contents(1), vec!["notes"]);

    b.state.comments.write(&seed()).unwrap().entry(2).or_default().insert(
        (3, 3),
        crate::comments::Comment::new(3, 3, 2, "a@b".into(), "me".into(), "a comment".into()),
    );
    assert_eq!(b.contents(2), vec!["comments"]);

    let b = Book::new(2);
    b.state.data_validations.write(&seed()).unwrap().entry(1).or_default().push(
        crate::data_validation::ValidationRange {
            start_row: 0,
            start_col: 0,
            end_row: 99,
            end_col: 0,
            validation: crate::data_validation::DataValidation::default(),
        },
    );
    assert_eq!(b.contents(1), vec!["data validation"]);

    let b = Book::new(1);
    crate::conditional_formatting::add_conditional_format_impl(
        &b.state,
        &crate::persistence::FileState::default(),
        crate::conditional_formatting::AddCFParams {
            target: None,
            rule: crate::conditional_formatting::ConditionalFormatRule::CellValue(
                crate::conditional_formatting::CellValueRule {
                    operator: crate::conditional_formatting::CellValueOperator::GreaterThan,
                    value1: "2".to_string(),
                    value2: None,
                },
            ),
            format: crate::conditional_formatting::ConditionalFormat {
                background_color: Some("#FFC7CE".to_string()),
                ..Default::default()
            },
            ranges: vec![crate::conditional_formatting::ConditionalFormatRange {
                start_row: 0,
                start_col: 0,
                end_row: 9,
                end_col: 0,
            }],
            stop_if_true: false,
        },
    );
    assert_eq!(b.contents(0), vec!["conditional formats"]);

    let b = Book::new(2);
    b.state.named_ranges.write(&seed()).unwrap().insert(
        "LOCAL".to_string(),
        crate::named_ranges::NamedRange {
            name: "LOCAL".to_string(),
            sheet_index: Some(1),
            refers_to: "=0.25".to_string(),
            comment: None,
            folder: None,
        },
    );
    assert_eq!(b.contents(1), vec!["sheet-scoped names"]);
    assert!(b.contents(0).is_empty(), "a name scoped to ANOTHER sheet does not count");
}

/// Cells, formatting and sizes -- on the ACTIVE sheet (the mirror and the
/// single-sheet fields) and OFF it (the per-sheet vectors).
#[test]
fn cells_formats_and_sizes_count_on_and_off_the_active_sheet() {
    let b = Book::new(2);
    b.state.grid.write(&seed()).unwrap().set_cell(4, 4, engine::Cell::new_number(1.0));
    assert_eq!(b.contents(0), vec!["cells"]);

    let mut formatted = engine::Cell::new();
    formatted.style_index = 3;
    b.state.grids.write(&seed()).unwrap()[1].set_cell(0, 0, formatted);
    assert_eq!(b.contents(1), vec!["cells"], "a formatting-only cell counts");

    let b = Book::new(2);
    b.state.grids.write(&seed()).unwrap()[1].set_column_style(2, 5);
    assert_eq!(b.contents(1), vec!["row or column formats"]);
    b.state.all_column_widths.write(&seed()).unwrap()[1].insert(3, 140.0);
    assert_eq!(b.contents(1), vec!["row or column formats", "column widths"]);
    b.state.row_heights.write(&seed()).unwrap().insert(2, 40.0);
    assert_eq!(b.contents(0), vec!["row heights"]);
}

/// Protection, a print area, and objects on the sheet.
#[test]
fn protection_a_print_area_and_objects_count() {
    let b = Book::new(2);
    b.state.sheet_protection.write(&seed()).unwrap().entry(1).or_default().protected = true;
    assert_eq!(b.contents(1), vec!["protection"]);
    // An UNprotected entry (options set, then unprotected) is not content.
    b.state.sheet_protection.write(&seed()).unwrap().entry(0).or_default();
    assert!(b.contents(0).is_empty());

    let b = Book::new(2);
    {
        let mut setups = b.state.page_setups.write(&seed()).unwrap();
        while setups.len() < 2 {
            setups.push(Default::default());
        }
        setups[1].print_area = "A1:D10".to_string();
    }
    assert_eq!(b.contents(1), vec!["a print area"]);

    let b = Book::new(2);
    b.state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: "pivot-1".into(),
        region_type: "pivot".into(),
        owner_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_index: 1,
        start_row: 0,
        start_col: 0,
        end_row: 3,
        end_col: 3,
        reserved_only: false,
    });
    assert_eq!(b.contents(1), vec!["PivotTables or reports"]);
    assert!(b.contents(0).is_empty());
}
