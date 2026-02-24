//! FILENAME: core/engine/src/undo.rs
//! PURPOSE: Undo/Redo history stack using the Command Pattern.
//! CONTEXT: Stores inverse operations to enable undo. Supports batching
//! multiple cell changes into a single transaction.

use std::collections::VecDeque;
use crate::cell::Cell;

/// Maximum number of undo operations to keep in history.
const MAX_HISTORY_SIZE: usize = 100;

/// Represents a single atomic change that can be undone.
#[derive(Debug, Clone)]
pub enum CellChange {
    /// A cell was modified: (row, col, previous_cell_state)
    /// If previous_cell_state is None, the cell was empty before.
    SetCell {
        row: u32,
        col: u32,
        previous: Option<Cell>,
    },
    /// A column width was changed: (col, previous_width)
    /// If previous_width is None, it was default width.
    SetColumnWidth {
        col: u32,
        previous: Option<f64>,
    },
    /// A row height was changed: (row, previous_height)
    /// If previous_height is None, it was default height.
    SetRowHeight {
        row: u32,
        previous: Option<f64>,
    },
}

/// A transaction groups multiple changes into one undoable action.
#[derive(Debug, Clone)]
pub struct Transaction {
    /// Human-readable description (e.g., "Paste 10 cells", "Clear range")
    pub description: String,
    /// The individual changes in this transaction (in order applied)
    pub changes: Vec<CellChange>,
}

impl Transaction {
    pub fn new(description: impl Into<String>) -> Self {
        Transaction {
            description: description.into(),
            changes: Vec::new(),
        }
    }

    pub fn add_change(&mut self, change: CellChange) {
        self.changes.push(change);
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

/// The history stack for undo/redo operations.
#[derive(Debug)]
pub struct UndoStack {
    /// Completed transactions that can be undone (most recent at back)
    undo_stack: VecDeque<Transaction>,
    /// Transactions that were undone and can be redone (most recent at back)
    redo_stack: VecDeque<Transaction>,
    /// Currently open transaction being built (for batching)
    current_transaction: Option<Transaction>,
    /// Maximum size of undo history
    max_size: usize,
}

impl UndoStack {
    pub fn new() -> Self {
        UndoStack {
            undo_stack: VecDeque::with_capacity(MAX_HISTORY_SIZE),
            redo_stack: VecDeque::with_capacity(MAX_HISTORY_SIZE),
            current_transaction: None,
            max_size: MAX_HISTORY_SIZE,
        }
    }

    pub fn with_max_size(max_size: usize) -> Self {
        UndoStack {
            undo_stack: VecDeque::with_capacity(max_size),
            redo_stack: VecDeque::with_capacity(max_size),
            current_transaction: None,
            max_size,
        }
    }

    /// Begin a new transaction for batching multiple changes.
    /// If a transaction is already open, this is a no-op (nested calls ignored).
    pub fn begin_transaction(&mut self, description: impl Into<String>) {
        if self.current_transaction.is_none() {
            self.current_transaction = Some(Transaction::new(description));
        }
    }

    /// Commit the current transaction to the undo stack.
    /// If no transaction is open or it's empty, this is a no-op.
    pub fn commit_transaction(&mut self) {
        if let Some(transaction) = self.current_transaction.take() {
            if !transaction.is_empty() {
                self.push_transaction(transaction);
            }
        }
    }

    /// Cancel the current transaction without saving it.
    pub fn cancel_transaction(&mut self) {
        self.current_transaction = None;
    }

    /// Record a cell change. If a transaction is open, add to it.
    /// Otherwise, create a single-change transaction.
    pub fn record_cell_change(&mut self, row: u32, col: u32, previous: Option<Cell>) {
        let change = CellChange::SetCell { row, col, previous };
        
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            // Auto-create a single-change transaction
            let mut transaction = Transaction::new(format!("Edit cell ({}, {})", row, col));
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Record a column width change.
    pub fn record_column_width_change(&mut self, col: u32, previous: Option<f64>) {
        let change = CellChange::SetColumnWidth { col, previous };
        
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new(format!("Resize column {}", col));
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Record a row height change.
    pub fn record_row_height_change(&mut self, row: u32, previous: Option<f64>) {
        let change = CellChange::SetRowHeight { row, previous };
        
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new(format!("Resize row {}", row));
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Push a completed transaction onto the undo stack.
    fn push_transaction(&mut self, transaction: Transaction) {
        // Clear redo stack when new action is performed
        self.redo_stack.clear();
        
        // Enforce max size
        while self.undo_stack.len() >= self.max_size {
            self.undo_stack.pop_front();
        }
        
        self.undo_stack.push_back(transaction);
    }

    /// Push a transaction to undo stack without clearing redo.
    /// Used internally by redo operation.
    pub fn push_undo_for_redo(&mut self, transaction: Transaction) {
        while self.undo_stack.len() >= self.max_size {
            self.undo_stack.pop_front();
        }
        self.undo_stack.push_back(transaction);
    }

    /// Pop the most recent transaction for undo.
    /// Returns None if nothing to undo.
    pub fn pop_undo(&mut self) -> Option<Transaction> {
        self.undo_stack.pop_back()
    }

    /// Push a transaction onto the redo stack (after undo).
    pub fn push_redo(&mut self, transaction: Transaction) {
        while self.redo_stack.len() >= self.max_size {
            self.redo_stack.pop_front();
        }
        self.redo_stack.push_back(transaction);
    }

    /// Pop the most recent transaction for redo.
    /// Returns None if nothing to redo.
    pub fn pop_redo(&mut self) -> Option<Transaction> {
        self.redo_stack.pop_back()
    }

    /// Check if undo is available.
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Check if redo is available.
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Get description of next undo action (for UI).
    pub fn undo_description(&self) -> Option<&str> {
        self.undo_stack.back().map(|t| t.description.as_str())
    }

    /// Get description of next redo action (for UI).
    pub fn redo_description(&self) -> Option<&str> {
        self.redo_stack.back().map(|t| t.description.as_str())
    }

    /// Clear all history.
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.current_transaction = None;
    }

    /// Get current stack sizes (for debugging).
    pub fn stack_sizes(&self) -> (usize, usize) {
        (self.undo_stack.len(), self.redo_stack.len())
    }
}

impl Default for UndoStack {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::CellValue;

    fn make_cell(val: f64) -> Cell {
        Cell {
            formula: None,
            value: CellValue::Number(val),
            style_index: 0,
            cached_ast: None,
        }
    }

    #[test]
    fn test_single_undo() {
        let mut stack = UndoStack::new();
        
        stack.record_cell_change(0, 0, None);
        assert!(stack.can_undo());
        assert!(!stack.can_redo());
        
        let transaction = stack.pop_undo().unwrap();
        assert_eq!(transaction.changes.len(), 1);
        assert!(!stack.can_undo());
    }

    #[test]
    fn test_transaction_batching() {
        let mut stack = UndoStack::new();
        
        stack.begin_transaction("Paste 3 cells");
        stack.record_cell_change(0, 0, None);
        stack.record_cell_change(0, 1, Some(make_cell(1.0)));
        stack.record_cell_change(0, 2, Some(make_cell(2.0)));
        stack.commit_transaction();
        
        assert!(stack.can_undo());
        let transaction = stack.pop_undo().unwrap();
        assert_eq!(transaction.description, "Paste 3 cells");
        assert_eq!(transaction.changes.len(), 3);
    }

    #[test]
    fn test_redo_after_undo() {
        let mut stack = UndoStack::new();
        
        stack.record_cell_change(0, 0, None);
        let transaction = stack.pop_undo().unwrap();
        stack.push_redo(transaction);
        
        assert!(stack.can_redo());
        let redo_transaction = stack.pop_redo().unwrap();
        assert_eq!(redo_transaction.changes.len(), 1);
    }

    #[test]
    fn test_redo_cleared_on_new_action() {
        let mut stack = UndoStack::new();
        
        stack.record_cell_change(0, 0, None);
        let transaction = stack.pop_undo().unwrap();
        stack.push_redo(transaction);
        
        assert!(stack.can_redo());
        
        // New action should clear redo
        stack.record_cell_change(1, 1, None);
        assert!(!stack.can_redo());
    }

    #[test]
    fn test_max_size_enforcement() {
        let mut stack = UndoStack::with_max_size(3);
        
        stack.record_cell_change(0, 0, None);
        stack.record_cell_change(1, 1, None);
        stack.record_cell_change(2, 2, None);
        stack.record_cell_change(3, 3, None); // Should evict oldest
        
        assert_eq!(stack.stack_sizes().0, 3);
    }

    #[test]
    fn test_empty_transaction_not_saved() {
        let mut stack = UndoStack::new();
        
        stack.begin_transaction("Empty");
        stack.commit_transaction();
        
        assert!(!stack.can_undo());
    }

    #[test]
    fn test_push_undo_for_redo_preserves_redo() {
        let mut stack = UndoStack::new();
        
        // Set up some redo state
        stack.record_cell_change(0, 0, None);
        let txn = stack.pop_undo().unwrap();
        stack.push_redo(txn);
        
        assert!(stack.can_redo());
        
        // push_undo_for_redo should NOT clear redo
        let new_txn = Transaction::new("Test");
        stack.push_undo_for_redo(new_txn);
        
        assert!(stack.can_redo()); // Redo should still be available
        assert!(stack.can_undo());
    }
}