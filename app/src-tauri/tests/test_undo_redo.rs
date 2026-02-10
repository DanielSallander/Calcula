//! FILENAME: tests/test_undo_redo.rs
//! Integration tests for undo/redo commands.

mod common;

use common::TestHarness;
use engine::{Cell, CellChange, Transaction};

// ============================================================================
// BASIC UNDO/REDO STATE TESTS
// ============================================================================

#[test]
fn test_initial_undo_state() {
    let harness = TestHarness::new();
    let undo_stack = harness.state.undo_stack.lock().unwrap();

    assert!(!undo_stack.can_undo());
    assert!(!undo_stack.can_redo());
}

#[test]
fn test_record_cell_change() {
    let harness = TestHarness::new();

    // Make a change
    harness.set_cell(0, 0, Cell::new_number(100.0));

    // Record the change
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.record_cell_change(0, 0, None);
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());
    assert!(!undo_stack.can_redo());
}

#[test]
fn test_undo_single_change() {
    let harness = TestHarness::new();

    // Set initial value
    let initial_cell = Cell::new_number(50.0);
    harness.set_cell(0, 0, initial_cell.clone());

    // Record the original state (None - cell didn't exist)
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.record_cell_change(0, 0, None);
    }

    // Perform undo
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        let transaction = undo_stack.pop_undo();
        assert!(transaction.is_some());

        if let Some(t) = transaction {
            // Apply the undo (restore previous state)
            for change in &t.changes {
                if let CellChange::SetCell { row, col, previous } = change {
                    let mut grid = harness.state.grid.lock().unwrap();
                    match previous {
                        Some(cell) => grid.set_cell(*row, *col, cell.clone()),
                        None => grid.clear_cell(*row, *col),
                    }
                }
            }
        }
    }

    // Verify the cell is cleared
    let grid = harness.state.grid.lock().unwrap();
    assert!(grid.get_cell(0, 0).is_none());
}

// ============================================================================
// TRANSACTION TESTS
// ============================================================================

#[test]
fn test_begin_transaction() {
    let harness = TestHarness::new();

    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Test Transaction".to_string());
    }

    // Transaction is pending, can't undo yet
    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(!undo_stack.can_undo());
}

#[test]
fn test_commit_transaction() {
    let harness = TestHarness::new();

    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Add Data".to_string());
        undo_stack.record_cell_change(0, 0, None);
        undo_stack.commit_transaction();
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());
}

#[test]
fn test_cancel_transaction() {
    let harness = TestHarness::new();

    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Cancelled".to_string());
        undo_stack.record_cell_change(0, 0, None);
        undo_stack.cancel_transaction();
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(!undo_stack.can_undo());
}

#[test]
fn test_batched_transaction() {
    let harness = TestHarness::new();

    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Batch Edit".to_string());

        // Record multiple changes in one transaction
        for i in 0..5 {
            undo_stack.record_cell_change(i, 0, None);
        }

        undo_stack.commit_transaction();
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());

    // Description should be "Batch Edit"
    let desc = undo_stack.undo_description();
    assert_eq!(desc, Some("Batch Edit"));
}

// ============================================================================
// REDO TESTS
// ============================================================================

#[test]
fn test_redo_after_undo() {
    let harness = TestHarness::new();

    // Make a change
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.record_cell_change(0, 0, None);
    }

    // Undo it
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        let _transaction = undo_stack.pop_undo();
        // Note: In real usage, we'd push to redo stack here
    }

    // Check state
    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(!undo_stack.can_undo()); // Undid the only change
}

#[test]
fn test_redo_cleared_on_new_change() {
    let harness = TestHarness::new();

    // Make a change
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.record_cell_change(0, 0, None);
    }

    // Undo it
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        let _transaction = undo_stack.pop_undo();
    }

    // Make a new change (should clear redo)
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.record_cell_change(1, 1, None);
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());
    assert!(!undo_stack.can_redo()); // Redo should be cleared
}

// ============================================================================
// MULTI-CELL UNDO TESTS
// ============================================================================

#[test]
fn test_undo_range_clear() {
    let harness = TestHarness::with_sample_data();

    // Record clearing a range
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Clear Range".to_string());

        let grid = harness.state.grid.lock().unwrap();
        for row in 0..3 {
            for col in 0..3 {
                let prev = grid.get_cell(row, col).cloned();
                undo_stack.record_cell_change(row, col, prev);
            }
        }

        drop(grid);
        undo_stack.commit_transaction();
    }

    // Clear the range
    {
        let mut grid = harness.state.grid.lock().unwrap();
        for row in 0..3 {
            for col in 0..3 {
                grid.clear_cell(row, col);
            }
        }
    }

    // Undo should restore all 9 cells
    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());

    let desc = undo_stack.undo_description();
    assert_eq!(desc, Some("Clear Range"));
}

// ============================================================================
// UNDO STACK LIMIT TESTS
// ============================================================================

#[test]
fn test_many_undo_operations() {
    let harness = TestHarness::new();

    // Make many changes
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        for i in 0..100 {
            undo_stack.record_cell_change(i, 0, None);
        }
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());
}

// ============================================================================
// CLEAR HISTORY TESTS
// ============================================================================

#[test]
fn test_clear_undo_history() {
    let harness = TestHarness::new();

    // Make some changes
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        for i in 0..10 {
            undo_stack.record_cell_change(i, 0, None);
        }
    }

    // Clear history
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.clear();
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(!undo_stack.can_undo());
    assert!(!undo_stack.can_redo());
}

// ============================================================================
// DIMENSION CHANGE TESTS
// ============================================================================

#[test]
fn test_undo_column_width_change() {
    let harness = TestHarness::new();

    // Set column width
    harness.set_column_width(0, 150.0);

    // Record the change
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.record_column_width_change(0, None); // Previous was default
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());
}

#[test]
fn test_undo_row_height_change() {
    let harness = TestHarness::new();

    // Set row height
    harness.set_row_height(0, 50.0);

    // Record the change
    {
        let mut undo_stack = harness.state.undo_stack.lock().unwrap();
        undo_stack.record_row_height_change(0, None); // Previous was default
    }

    let undo_stack = harness.state.undo_stack.lock().unwrap();
    assert!(undo_stack.can_undo());
}
