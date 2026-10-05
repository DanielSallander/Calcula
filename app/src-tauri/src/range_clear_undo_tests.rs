//! FILENAME: app/src-tauri/src/range_clear_undo_tests.rs
//! PURPOSE: The RANGE clears of comments, notes and hyperlinks are undoable.
//! CONTEXT: A `#[path]` child of `comments`. Clear Comments and Notes, Clear
//!          Hyperlinks and Clear All reach `clear_comments_in_range`,
//!          `clear_notes_in_range` and `clear_hyperlinks_in_range`; none of the
//!          three recorded an undo entry (only the single-item deletes did), so
//!          Ctrl+Z after Clear Comments did nothing and undoing Clear All
//!          brought the cells back without what lived on them. Each removed item
//!          is now recorded inside ONE owned transaction: its own step, or the
//!          caller's step when Clear All holds one open. A clear that finds
//!          nothing changes nothing and leaves the document clean.

use crate::comments::Comment;
use crate::hyperlinks::Hyperlink;
use crate::notes::Note;
use crate::persistence::FileState;
use crate::AppState;

struct Book {
    state: AppState,
    file: FileState,
}

fn book() -> Book {
    let book = Book { state: crate::create_app_state(), file: FileState::default() };
    let seed = crate::document_effect::test_seed_effect();
    {
        let mut comments = book.state.comments.write(&seed).unwrap();
        let sheet = comments.entry(0).or_default();
        sheet.insert((1, 1), Comment::new(1, 1, 0, "a@b".into(), "me".into(), "first".into()));
        sheet.insert((2, 2), Comment::new(2, 2, 0, "a@b".into(), "me".into(), "second".into()));
        sheet.insert((9, 9), Comment::new(9, 9, 0, "a@b".into(), "me".into(), "outside".into()));
    }
    {
        let mut notes = book.state.notes.write(&seed).unwrap();
        let sheet = notes.entry(0).or_default();
        sheet.insert((1, 2), Note::new(1, 2, 0, "me".into(), "n1".into()));
        sheet.insert((9, 8), Note::new(9, 8, 0, "me".into(), "outside".into()));
    }
    {
        let mut links = book.state.hyperlinks.write(&seed).unwrap();
        let sheet = links.entry(0).or_default();
        sheet.insert((2, 1), Hyperlink::new_url(2, 1, 0, "https://example.com/a".into()));
        sheet.insert((3, 3), Hyperlink::new_url(3, 3, 0, "https://example.com/b".into()));
    }
    book
}

fn undo(book: &Book) {
    let transaction = book.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
    crate::undo_commands::apply_changes(
        &book.state,
        &book.file,
        &crate::persistence::UserFilesState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        transaction,
        true,
    );
}

fn depth(book: &Book) -> usize {
    book.state.undo_stack.lock().unwrap().undo_depth()
}

#[test]
fn clearing_comments_in_a_range_is_one_undo_step() {
    let book = book();
    let before = depth(&book);
    let removed = crate::comments::clear_comments_in_range_impl(&book.state, &book.file, 0, 0, 3, 3);
    assert_eq!(removed, 2);
    assert_eq!(depth(&book), before + 1, "two comments, ONE step");
    assert!(book.file.is_dirty());
    assert_eq!(book.state.comments.read().unwrap().get(&0).unwrap().len(), 1, "the one outside stays");

    undo(&book);
    let comments = book.state.comments.read().unwrap();
    let sheet = comments.get(&0).unwrap();
    assert_eq!(sheet.len(), 3, "undo brings both back");
    assert_eq!(sheet.get(&(2, 2)).map(|c| c.content.as_str()), Some("second"));
}

#[test]
fn clearing_notes_in_a_range_is_one_undo_step() {
    let book = book();
    let before = depth(&book);
    assert_eq!(crate::notes::clear_notes_in_range_impl(&book.state, &book.file, 0, 0, 3, 3), 1);
    assert_eq!(depth(&book), before + 1);
    assert!(!book.state.notes.read().unwrap().get(&0).unwrap().contains_key(&(1, 2)));
    undo(&book);
    assert_eq!(
        book.state.notes.read().unwrap().get(&0).unwrap().get(&(1, 2)).map(|n| n.content.as_str()),
        Some("n1")
    );
}

#[test]
fn clearing_hyperlinks_in_a_range_is_one_undo_step() {
    let book = book();
    let before = depth(&book);
    assert_eq!(crate::hyperlinks::clear_hyperlinks_in_range_impl(&book.state, &book.file, 3, 3, 0, 0), 2, "any corner order");
    assert_eq!(depth(&book), before + 1);
    assert!(book.state.hyperlinks.read().unwrap().get(&0).unwrap().is_empty());
    undo(&book);
    assert_eq!(book.state.hyperlinks.read().unwrap().get(&0).unwrap().len(), 2);
}

/// Clear All runs all three inside ITS transaction: they join it, so one
/// Ctrl+Z restores every one of them together.
#[test]
fn inside_a_callers_transaction_the_clears_join_its_one_step() {
    let book = book();
    let before = depth(&book);
    book.state.undo_stack.lock().unwrap().begin_transaction("Clear All");
    crate::comments::clear_comments_in_range_impl(&book.state, &book.file, 0, 0, 3, 3);
    crate::notes::clear_notes_in_range_impl(&book.state, &book.file, 0, 0, 3, 3);
    crate::hyperlinks::clear_hyperlinks_in_range_impl(&book.state, &book.file, 0, 0, 3, 3);
    book.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(depth(&book), before + 1);
    undo(&book);
    assert_eq!(book.state.comments.read().unwrap().get(&0).unwrap().len(), 3);
    assert_eq!(book.state.notes.read().unwrap().get(&0).unwrap().len(), 2);
    assert_eq!(book.state.hyperlinks.read().unwrap().get(&0).unwrap().len(), 2);
}

/// A range that holds nothing changes nothing: no undo step, a clean document
/// (all three used to dirty it unconditionally).
#[test]
fn an_empty_range_clear_records_nothing_and_leaves_the_document_clean() {
    let book = book();
    let before = depth(&book);
    assert_eq!(crate::comments::clear_comments_in_range_impl(&book.state, &book.file, 5, 5, 6, 6), 0);
    assert_eq!(crate::notes::clear_notes_in_range_impl(&book.state, &book.file, 5, 5, 6, 6), 0);
    assert_eq!(crate::hyperlinks::clear_hyperlinks_in_range_impl(&book.state, &book.file, 5, 5, 6, 6), 0);
    assert_eq!(depth(&book), before);
    assert!(!book.file.is_dirty());
}
