//! FILENAME: core/engine/src/undo.rs
//! PURPOSE: Undo/Redo history stack using the Command Pattern.
//! CONTEXT: Stores inverse operations to enable undo. Supports batching
//! multiple cell changes into a single transaction.

use std::collections::{HashMap, HashSet, VecDeque};
use crate::cell::Cell;
use crate::grid::CellMap;

/// Maximum number of undo operations to keep in history.
const MAX_HISTORY_SIZE: usize = 100;

/// A merged region stored in undo history (engine-level, no dependency on api_types).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UndoMergeRegion {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Snapshot of grid state for reversing structural changes (insert/delete rows/columns).
#[derive(Debug, Clone)]
pub struct GridSnapshot {
    pub cells: CellMap,
    pub row_heights: HashMap<u32, f64>,
    pub column_widths: HashMap<u32, f64>,
    pub merged_regions: HashSet<UndoMergeRegion>,
    pub max_row: u32,
    pub max_col: u32,
    /// Row/column default-style tiers. Captured here for the same reason
    /// `merged_regions` is: a structural edit shifts them, and undo restores
    /// the snapshot wholesale rather than each store recording its own inverse.
    pub row_styles: HashMap<u32, usize>,
    pub column_styles: HashMap<u32, usize>,
}

/// Represents a single atomic change that can be undone.
#[derive(Debug, Clone)]
pub enum CellChange {
    /// A cell was modified: (sheet, row, col, previous_cell_state)
    /// If previous_cell_state is None, the cell was empty before.
    ///
    /// `sheet` is the sheet index the change was recorded ON. It is not
    /// decoration: without it an undo entry cannot say WHICH sheet it
    /// restores, so a restore issued after a sheet switch landed on
    /// whatever sheet happened to be active and silently overwrote it.
    /// That is the same sheet-blindness that made cross-sheet
    /// recalculation wrong (BUG-0019) and that left the restore -> recalc
    /// seed channel unable to express an off-sheet seed at all.
    SetCell {
        sheet: usize,
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
    /// A merge region was added (undo = remove it).
    AddMergeRegion(UndoMergeRegion),
    /// A merge region was removed (undo = add it back).
    RemoveMergeRegion(UndoMergeRegion),
    /// Full grid snapshot for structural changes (insert/delete rows/columns).
    /// Undo = restore the snapshot, Redo = restore the other snapshot.
    RestoreSnapshot(GridSnapshot),
    /// Application-level custom undo data (comments, notes, hyperlinks, etc.).
    /// `kind` identifies the subsystem; `data` is the serialized previous state.
    /// The engine stores this opaquely; the app layer handles serialization.
    CustomRestore { kind: String, data: Vec<u8> },
}

/// A transaction groups multiple changes into one undoable action.
#[derive(Debug, Clone)]
pub struct Transaction {
    /// Human-readable description (e.g., "Paste 10 cells", "Clear range")
    pub description: String,
    /// The individual changes in this transaction (in order applied)
    pub changes: Vec<CellChange>,
    /// Identity of this entry in the history, assigned the first time it is
    /// pushed onto the undo stack. `0` means "never pushed".
    ///
    /// It exists because DEPTH IS NOT POSITION. History is capped
    /// (`MAX_HISTORY_SIZE`), so once the cap is reached every further push
    /// silently drops the oldest entry and `undo_depth()` stops growing --
    /// which makes "undo (depth_now - depth_then) times" walk back a
    /// different distance than the caller believes. A caller that wants to
    /// return to a remembered point has to remember an ID, not a count.
    ///
    /// Preserved across undo/redo: the inverse transaction a restore builds
    /// inherits this seq, so undo-then-redo puts the SAME id back on the
    /// stack rather than a fresh one.
    pub seq: u64,
}

impl Transaction {
    pub fn new(description: impl Into<String>) -> Self {
        Transaction {
            description: description.into(),
            changes: Vec::new(),
            seq: 0,
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
    /// Id to assign to the next transaction pushed. Never reset and never
    /// reused -- not even by `clear()` -- so a remembered id can never be
    /// matched by a LATER transaction that happened to land in the same slot.
    next_seq: u64,
    /// How many transactions the size cap has silently dropped, ever. The
    /// only signal that history older than the cap is gone; without it a
    /// caller cannot tell "nothing was pushed" from "what you remembered has
    /// been evicted".
    evicted_total: u64,
}

impl UndoStack {
    pub fn new() -> Self {
        UndoStack {
            undo_stack: VecDeque::with_capacity(MAX_HISTORY_SIZE),
            redo_stack: VecDeque::with_capacity(MAX_HISTORY_SIZE),
            current_transaction: None,
            max_size: MAX_HISTORY_SIZE,
            next_seq: 1,
            evicted_total: 0,
        }
    }

    pub fn with_max_size(max_size: usize) -> Self {
        UndoStack {
            undo_stack: VecDeque::with_capacity(max_size),
            redo_stack: VecDeque::with_capacity(max_size),
            current_transaction: None,
            max_size,
            next_seq: 1,
            evicted_total: 0,
        }
    }

    /// Check if a transaction is currently open.
    /// Used by batch operations to avoid premature commit when an outer
    /// transaction was already opened by the caller.
    pub fn has_open_transaction(&self) -> bool {
        self.current_transaction.is_some()
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
    pub fn record_cell_change(
        &mut self,
        sheet: usize,
        row: u32,
        col: u32,
        previous: Option<Cell>,
    ) {
        let change = CellChange::SetCell { sheet, row, col, previous };
        
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

    /// Record that a merge region was added (for undo of merge).
    pub fn record_merge_region_added(&mut self, region: UndoMergeRegion) {
        let change = CellChange::AddMergeRegion(region);
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new("Merge cells".to_string());
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Record that a merge region was removed (for undo of unmerge).
    pub fn record_merge_region_removed(&mut self, region: UndoMergeRegion) {
        let change = CellChange::RemoveMergeRegion(region);
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new("Unmerge cells".to_string());
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Record a custom restore change (for app-level metadata like comments, notes, etc.).
    /// If no transaction is open, creates a standalone transaction with the given description.
    pub fn record_custom_restore(&mut self, kind: String, data: Vec<u8>, description: &str) {
        let change = CellChange::CustomRestore { kind, data };
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new(description);
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Get a mutable reference to the current open transaction (if any).
    pub fn current_transaction_mut(&mut self) -> Option<&mut Transaction> {
        self.current_transaction.as_mut()
    }

    /// Push a completed transaction directly (used when auto-creating single-change transactions).
    /// Clears the redo stack.
    pub fn push_transaction_direct(&mut self, transaction: Transaction) {
        self.push_transaction(transaction);
    }

    /// Record a full grid snapshot for structural changes.
    pub fn record_snapshot(&mut self, snapshot: GridSnapshot) {
        let change = CellChange::RestoreSnapshot(snapshot);
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        }
        // Snapshots should always be within a transaction (caller must begin one)
    }

    /// Push a completed transaction onto the undo stack.
    fn push_transaction(&mut self, transaction: Transaction) {
        // Clear redo stack when new action is performed
        self.redo_stack.clear();
        self.push_back_capped(transaction);
    }

    /// Push a transaction to undo stack without clearing redo.
    /// Used internally by redo operation.
    pub fn push_undo_for_redo(&mut self, transaction: Transaction) {
        self.push_back_capped(transaction);
    }

    /// Stamp an id (first push only) and push, dropping the oldest entries
    /// once the cap is reached -- and COUNTING what was dropped, which is the
    /// only trace an eviction leaves.
    fn push_back_capped(&mut self, mut transaction: Transaction) {
        if transaction.seq == 0 {
            transaction.seq = self.next_seq;
            self.next_seq += 1;
        }
        while self.undo_stack.len() >= self.max_size {
            if self.undo_stack.pop_front().is_none() {
                break;
            }
            self.evicted_total += 1;
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

    /// Number of transactions available to undo.
    ///
    /// NOT a position. Two depths read at different times must not be
    /// subtracted to get "how many steps back is then from now": the cap
    /// makes depth saturate, and an undo performed between the readings
    /// removes an entry the difference never sees. Use `undo_seqs()`.
    pub fn undo_depth(&self) -> usize {
        self.undo_stack.len()
    }

    /// The ids of the undo stack's entries, oldest first -- the history's
    /// actual shape, which `undo_depth()` can only summarize.
    ///
    /// A caller that remembered the id on top at some earlier point can find
    /// it here and count what sits above it; if it is absent, that point is
    /// unreachable (evicted by the cap, or already undone past) and NO number
    /// of undo steps restores the state it named.
    pub fn undo_seqs(&self) -> Vec<u64> {
        self.undo_stack.iter().map(|t| t.seq).collect()
    }

    /// How many transactions the cap has dropped over this stack's lifetime.
    pub fn evicted_total(&self) -> u64 {
        self.evicted_total
    }

    /// The history cap -- how many transactions are kept before the oldest
    /// starts being dropped.
    pub fn max_size(&self) -> usize {
        self.max_size
    }

    /// Number of transactions available to redo.
    pub fn redo_depth(&self) -> usize {
        self.redo_stack.len()
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
    /// Visit every queued `CustomRestore` payload, in both stacks and any open
    /// transaction, so the host can rewrite payloads that have become stale.
    ///
    /// Exists for ONE reason: those payloads identify their target sheet by
    /// INDEX, and deleting or moving a sheet renumbers every index after it.
    /// The live stores are remapped at that moment, but queued undo entries are
    /// not — so undoing past a sheet delete used to replay a restore into
    /// whatever sheet had since taken that index, silently corrupting it.
    ///
    /// Deliberately a visitor rather than a public accessor: the stacks stay
    /// private, and the host cannot reorder or drop history through this.
    pub fn visit_custom_restores(&mut self, mut visit: impl FnMut(&str, &mut Vec<u8>)) {
        let open = self.current_transaction.iter_mut();
        for transaction in self
            .undo_stack
            .iter_mut()
            .chain(self.redo_stack.iter_mut())
            .chain(open)
        {
            for change in transaction.changes.iter_mut() {
                if let CellChange::CustomRestore { kind, data } = change {
                    visit(kind, data);
                }
            }
        }
    }

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
            ast: None,
            value: CellValue::Number(val),
            style_index: 0,
            rich_text: None,
        }
    }

    #[test]
    fn test_single_undo() {
        let mut stack = UndoStack::new();
        
        stack.record_cell_change(0, 0, 0, None);
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
        stack.record_cell_change(0, 0, 0, None);
        stack.record_cell_change(0, 0, 1, Some(make_cell(1.0)));
        stack.record_cell_change(0, 0, 2, Some(make_cell(2.0)));
        stack.commit_transaction();
        
        assert!(stack.can_undo());
        let transaction = stack.pop_undo().unwrap();
        assert_eq!(transaction.description, "Paste 3 cells");
        assert_eq!(transaction.changes.len(), 3);
    }

    #[test]
    fn test_redo_after_undo() {
        let mut stack = UndoStack::new();
        
        stack.record_cell_change(0, 0, 0, None);
        let transaction = stack.pop_undo().unwrap();
        stack.push_redo(transaction);
        
        assert!(stack.can_redo());
        let redo_transaction = stack.pop_redo().unwrap();
        assert_eq!(redo_transaction.changes.len(), 1);
    }

    #[test]
    fn test_redo_cleared_on_new_action() {
        let mut stack = UndoStack::new();
        
        stack.record_cell_change(0, 0, 0, None);
        let transaction = stack.pop_undo().unwrap();
        stack.push_redo(transaction);
        
        assert!(stack.can_redo());
        
        // New action should clear redo
        stack.record_cell_change(0, 1, 1, None);
        assert!(!stack.can_redo());
    }

    #[test]
    fn test_max_size_enforcement() {
        let mut stack = UndoStack::with_max_size(3);
        
        stack.record_cell_change(0, 0, 0, None);
        stack.record_cell_change(0, 1, 1, None);
        stack.record_cell_change(0, 2, 2, None);
        stack.record_cell_change(0, 3, 3, None); // Should evict oldest
        
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
        stack.record_cell_change(0, 0, 0, None);
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
#[cfg(test)]
mod visit_custom_restores_tests {
    use super::*;

    fn payload(sheet: usize) -> Vec<u8> {
        format!("{{\"sheet_index\":{},\"data\":\"x\"}}", sheet).into_bytes()
    }

    #[test]
    fn the_visitor_reaches_both_stacks_and_the_open_transaction() {
        // All three matter: a sheet delete can happen with entries queued for
        // undo, entries queued for redo, and a transaction still open.
        let mut stack = UndoStack::new();

        stack.begin_transaction("committed");
        stack.record_custom_restore("obj_x".into(), payload(3), "a");
        stack.commit_transaction();

        // Move it to the redo stack.
        let popped = stack.pop_undo().expect("one transaction");
        stack.push_redo(popped);

        stack.begin_transaction("still open");
        stack.record_custom_restore("obj_y".into(), payload(3), "b");

        let mut seen = 0;
        stack.visit_custom_restores(|_kind, data| {
            seen += 1;
            // Rewrite sheet 3 -> 1, the way a sheet delete would.
            let s = String::from_utf8(data.clone()).unwrap();
            *data = s.replace("\"sheet_index\":3", "\"sheet_index\":1").into_bytes();
        });
        assert_eq!(seen, 2, "redo-stack and open-transaction payloads both visited");

        let mut rewritten = 0;
        stack.visit_custom_restores(|_kind, data| {
            let s = String::from_utf8(data.clone()).unwrap();
            assert!(s.contains("\"sheet_index\":1"), "payload not rewritten: {s}");
            rewritten += 1;
        });
        assert_eq!(rewritten, 2);
    }
}

/// The history HORIZON: what `undo_depth()` cannot say, and what `undo_seqs()`
/// can.
///
/// Every one of these is the arithmetic that the undo-round-trip oracle used
/// to do -- "remember the depth, act, then undo (depth_now - depth_then)
/// times to get back" -- run against a stack that is allowed to forget. The
/// arithmetic is sound only while the cap is not reached and nothing else
/// undoes in between, and the soak walk satisfied neither.
#[cfg(test)]
mod history_horizon_tests {
    use super::*;

    fn push(stack: &mut UndoStack, n: usize) {
        for i in 0..n {
            stack.record_cell_change(0, i as u32, 0, None);
        }
    }

    #[test]
    fn depth_saturates_at_the_cap_so_the_difference_undercounts() {
        // 10-deep history. Remember the depth after 7 pushes, then push 6
        // more: 3 of the remembered entries are silently dropped, depth grows
        // by 3 instead of 6, and "undo the difference" walks back HALF the
        // distance the caller asked for.
        let mut stack = UndoStack::with_max_size(10);
        push(&mut stack, 7);
        let remembered_depth = stack.undo_depth();
        assert_eq!(remembered_depth, 7);

        push(&mut stack, 6);

        assert_eq!(stack.undo_depth(), 10, "capped");
        assert_eq!(
            stack.undo_depth() - remembered_depth,
            3,
            "the difference says 3 steps; SIX transactions were pushed"
        );
        assert_eq!(stack.evicted_total(), 3, "and three were dropped");
    }

    #[test]
    fn seqs_count_the_distance_the_difference_gets_wrong() {
        // Same walk, with an id remembered instead of a count. The id is the
        // top of the stack at the remembered moment; the number of entries
        // ABOVE it is the true number of undo steps back to that state.
        let mut stack = UndoStack::with_max_size(10);
        push(&mut stack, 7);
        let marker = *stack.undo_seqs().last().unwrap();

        push(&mut stack, 6);

        let seqs = stack.undo_seqs();
        let position = seqs.iter().position(|s| *s == marker).expect("still held");
        assert_eq!(
            seqs.len() - 1 - position,
            6,
            "six transactions sit above the remembered point -- the true distance"
        );
    }

    #[test]
    fn an_evicted_marker_is_unreachable_and_says_so() {
        // Push past the cap far enough that the remembered entry is gone.
        // There is no number of undo steps that restores that state, and the
        // stack reports the fact rather than letting a count pretend.
        let mut stack = UndoStack::with_max_size(10);
        push(&mut stack, 3);
        let marker = *stack.undo_seqs().last().unwrap();

        push(&mut stack, 12);

        assert!(
            !stack.undo_seqs().contains(&marker),
            "the remembered entry has been dropped by the cap"
        );
        assert!(stack.evicted_total() >= 1);
    }

    #[test]
    fn an_undo_inside_the_window_does_not_break_the_count() {
        // Remember a point, push three, undo one of them, push one more.
        // Depth arithmetic gives 3 (4 pushes minus 1 undo) and happens to be
        // right here; the id-based count agrees, which is the point -- the
        // exact instrument must not be MORE conservative than the sloppy one
        // in the cases the sloppy one gets right.
        let mut stack = UndoStack::with_max_size(100);
        push(&mut stack, 2);
        let marker = *stack.undo_seqs().last().unwrap();
        let remembered_depth = stack.undo_depth();

        push(&mut stack, 3);
        let undone = stack.pop_undo().expect("something to undo");
        stack.push_redo(undone);
        push(&mut stack, 1);

        let seqs = stack.undo_seqs();
        let position = seqs.iter().position(|s| *s == marker).expect("still held");
        assert_eq!(seqs.len() - 1 - position, 3);
        assert_eq!(stack.undo_depth() - remembered_depth, 3, "agrees here");
    }

    #[test]
    fn undoing_past_the_marker_makes_it_unreachable() {
        // The case the difference gets silently WRONG in the other direction:
        // an undo that reaches back before the remembered point removes it,
        // and the entry it reverted can never be redone once a later push
        // clears the redo stack. The marker is simply absent -- which a count
        // has no way of noticing.
        let mut stack = UndoStack::with_max_size(100);
        push(&mut stack, 2);
        let marker = *stack.undo_seqs().last().unwrap();

        let undone = stack.pop_undo().expect("the marker transaction");
        assert_eq!(undone.seq, marker);
        stack.push_redo(undone);
        push(&mut stack, 1);

        assert!(!stack.undo_seqs().contains(&marker));
        assert!(!stack.can_redo(), "a push clears redo; that state is gone");
    }

    #[test]
    fn undo_then_redo_puts_the_same_id_back() {
        // Ids survive the round trip, so a walk that undoes and redoes inside
        // a window leaves the remembered point exactly where it was. Without
        // this the redone entry would arrive with a fresh id and every later
        // check would report the window as unreachable.
        let mut stack = UndoStack::with_max_size(100);
        push(&mut stack, 3);
        let before = stack.undo_seqs();

        let undone = stack.pop_undo().unwrap();
        let seq = undone.seq;
        stack.push_redo(undone);
        let redone = stack.pop_redo().unwrap();
        assert_eq!(redone.seq, seq, "the id travels with the transaction");
        stack.push_undo_for_redo(redone);

        assert_eq!(stack.undo_seqs(), before);
    }

    #[test]
    fn ids_are_never_reused_even_after_clear() {
        // `clear()` drops the history; it must not reset the counter, or a
        // brand-new transaction would answer to an id someone remembered from
        // the previous document and a stale marker would look reachable.
        let mut stack = UndoStack::with_max_size(10);
        push(&mut stack, 3);
        let stale = *stack.undo_seqs().last().unwrap();

        stack.clear();
        push(&mut stack, 3);

        assert!(!stack.undo_seqs().contains(&stale));
        assert!(stack.undo_seqs().iter().all(|s| *s > stale));
    }
}
