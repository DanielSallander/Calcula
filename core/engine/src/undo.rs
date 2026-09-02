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
    /// The sheet this snapshot was taken FROM, and the only sheet it may ever
    /// be restored INTO.
    ///
    /// Without it the restore was "replace the active sheet's whole grid with
    /// these cells", whichever sheet happened to be active. Insert a row on
    /// Sheet2, switch to Sheet1, press Ctrl+Z, and Sheet1's entire cell map was
    /// replaced by Sheet2's — the single largest silent data loss in the undo
    /// path, and the same missing dimension `SetCell.sheet` exists for.
    pub sheet: usize,
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
    /// A column width was changed: (sheet, col, previous_width)
    /// If previous_width is None, it was default width.
    ///
    /// `sheet`, like `SetCell`'s, is the sheet the change was recorded ON.
    /// These four variants used to carry no sheet at all — they were
    /// implicitly "the active sheet", which is true when they are RECORDED and
    /// need not be true when they are RESTORED.
    SetColumnWidth {
        sheet: usize,
        col: u32,
        previous: Option<f64>,
    },
    /// A row height was changed: (sheet, row, previous_height)
    /// If previous_height is None, it was default height.
    SetRowHeight {
        sheet: usize,
        row: u32,
        previous: Option<f64>,
    },
    /// A merge region was added (undo = remove it).
    AddMergeRegion { sheet: usize, region: UndoMergeRegion },
    /// A merge region was removed (undo = add it back).
    RemoveMergeRegion { sheet: usize, region: UndoMergeRegion },
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

    /// The sheet this transaction's action HAPPENED ON, if it can be told.
    ///
    /// Excel keeps one undo history and switches to the sheet the undone
    /// action was performed on, so the user sees what changed rather than
    /// having a value silently move on a sheet they are not looking at. That
    /// switch needs a single answer to "which sheet", and this is it.
    ///
    /// THE FIRST RECORDED CHANGE WINS, not the first APPLIED one. A restore
    /// replays `changes` in reverse, but the sheet a user would name as "where
    /// I did that" is where the action STARTED -- the first cell a fill, a
    /// paste or a grouped script batch wrote. The two differ only for a
    /// transaction that spans sheets, which is rare and has no better answer;
    /// picking the reverse order would make an ordinary single-sheet
    /// transaction agree and a cross-sheet one point at its tail.
    ///
    /// `None` means the transaction carries no sheet at all: it is made only of
    /// `CustomRestore` payloads (a comment, a hyperlink, a pivot definition),
    /// whose sheet lives inside opaque bytes this layer must not parse. A
    /// caller that gets `None` must leave the active sheet alone -- guessing
    /// "the active one" would be exactly the sheet-blindness `SetCell.sheet`
    /// was added to end.
    pub fn target_sheet(&self) -> Option<usize> {
        self.changes.iter().find_map(|change| match change {
            CellChange::SetCell { sheet, .. }
            | CellChange::SetColumnWidth { sheet, .. }
            | CellChange::SetRowHeight { sheet, .. }
            | CellChange::AddMergeRegion { sheet, .. }
            | CellChange::RemoveMergeRegion { sheet, .. } => Some(*sheet),
            CellChange::RestoreSnapshot(snapshot) => Some(snapshot.sheet),
            CellChange::CustomRestore { .. } => None,
        })
    }

    /// The top-left CELL this transaction restores on `sheet`, if any.
    ///
    /// Activating a sheet is only half of "so the user can see what changed":
    /// the restored cells can sit far outside the viewport the sheet was left
    /// at, and a switch that lands somewhere else shows nothing. This is the
    /// coordinate the view is aimed at.
    ///
    /// `SetCell` only. The geometry variants describe a whole row or column
    /// and `RestoreSnapshot` describes the whole sheet, so neither names a cell
    /// worth pointing at; `CustomRestore` is opaque here for the reason
    /// `target_sheet` gives.
    pub fn restored_anchor_on(&self, sheet: usize) -> Option<(u32, u32)> {
        self.restored_range_on(sheet).map(|(row, col, _, _)| (row, col))
    }

    /// The bounding BOX this transaction restores on `sheet`, as
    /// `(min_row, min_col, max_row, max_col)`.
    ///
    /// Excel selects the range an undo restored, not merely its corner: undo a
    /// four-cell paste and all four cells come back selected. `restored_anchor_on`
    /// is now the top-left corner of this box rather than a second walk of the
    /// same changes, so the two can never disagree about which cells the restore
    /// touched.
    ///
    /// SAME `SetCell`-ONLY SCOPE, and it is a real limit rather than an
    /// oversight: the geometry variants describe a whole row or column,
    /// `RestoreSnapshot` describes the whole sheet, and `CustomRestore` is opaque
    /// (see `target_sheet`). Excel selects the affected rows for an insert/delete
    /// undo; Calcula cannot, because the transaction does not record which they
    /// were. A `None` here means "do not move the user", which is the same
    /// answer the view took for every restore before Excel parity was decided --
    /// so the gap is a narrower silence, never a wrong selection.
    ///
    /// The box is a BOUNDING box: a transaction touching (9,4) and (6,7) yields
    /// rows 6..=9 and columns 4..=7, including the two corners nobody wrote.
    /// That is Excel's rectangle too -- a selection is a rectangle -- and it is
    /// why the per-axis `min`/`max` must stay independent.
    pub fn restored_range_on(&self, sheet: usize) -> Option<(u32, u32, u32, u32)> {
        self.changes
            .iter()
            .filter_map(|change| match change {
                CellChange::SetCell { sheet: s, row, col, .. } if *s == sheet => {
                    Some((*row, *col, *row, *col))
                }
                _ => None,
            })
            .reduce(|a, b| {
                (
                    a.0.min(b.0),
                    a.1.min(b.1),
                    a.2.max(b.2),
                    a.3.max(b.3),
                )
            })
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
    /// How many transactions a WHOLESALE `clear()` has discarded, ever.
    ///
    /// A separate counter from `evicted_total` because the two are different
    /// facts with different remedies. Eviction means "your history is longer
    /// than the cap"; a clear means "something ENDED the history" -- a sheet
    /// was added, deleted, renamed, moved or copied, or the document itself
    /// was replaced. A caller that remembered an id and cannot find it needs
    /// to know WHICH of those happened, or it reports a product defect where
    /// Excel-parity behaviour is all it observed.
    cleared_total: u64,
    /// How many times a wholesale `clear()` has HAPPENED, ever — regardless
    /// of how much it discarded.
    ///
    /// `cleared_total` counts TRANSACTIONS, and it is zero when the stack was
    /// already empty. That is exactly the case that makes correct behaviour
    /// look like a defect: a sheet added while the history happens to be empty
    /// ends nothing, so `cleared_total` does not move — and a caller comparing
    /// two readings concludes the window is fully undoable. It is not. The
    /// sheet ADD itself is not undoable, so no number of undo steps returns to
    /// the earlier state.
    ///
    /// MEASURED on soak seed 1786446166374: `Undoing 22 steps did not restore
    /// the checkpoint state ... sheetNames[2]: "<absent>" -> "Sheet3"` — where
    /// Sheet3 was an EMPTY sheet the walk had added, and the two digest
    /// differences were that sheet and nothing else. A report about undo,
    /// produced by an action Excel does not let you undo, which is the exact
    /// false alarm BUG-0005's fix removed for the non-empty case and left
    /// standing for this one.
    clears_total: u64,
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
            cleared_total: 0,
            clears_total: 0,
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
            cleared_total: 0,
            clears_total: 0,
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

    /// Commit the current transaction to the undo stack, returning the id it
    /// was stamped with. If no transaction is open or it's empty, this is a
    /// no-op and returns `None`.
    ///
    /// RETURNING THE ID IS WHAT MAKES A SELF-REVERSING COMMAND POSSIBLE. A
    /// command that writes, hands control back, and must later reverse its OWN
    /// write has to name the entry it left — and the only way to name it without
    /// a race is to be handed it by the push itself. Observing the top of the
    /// stack afterwards is a second critical section, and anything that lands in
    /// between is then adopted as the caller's own: worse than a bare undo,
    /// because the caller reverses a stranger's work confidently.
    pub fn commit_transaction(&mut self) -> Option<u64> {
        if let Some(transaction) = self.current_transaction.take() {
            if !transaction.is_empty() {
                return Some(self.push_transaction(transaction));
            }
        }
        None
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

    /// Record a column width change on `sheet`.
    pub fn record_column_width_change(&mut self, sheet: usize, col: u32, previous: Option<f64>) {
        let change = CellChange::SetColumnWidth { sheet, col, previous };
        
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new(format!("Resize column {}", col));
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Record a row height change on `sheet`.
    pub fn record_row_height_change(&mut self, sheet: usize, row: u32, previous: Option<f64>) {
        let change = CellChange::SetRowHeight { sheet, row, previous };

        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new(format!("Resize row {}", row));
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Record that a merge region was added on `sheet` (for undo of merge).
    pub fn record_merge_region_added(&mut self, sheet: usize, region: UndoMergeRegion) {
        let change = CellChange::AddMergeRegion { sheet, region };
        if let Some(ref mut transaction) = self.current_transaction {
            transaction.add_change(change);
        } else {
            let mut transaction = Transaction::new("Merge cells".to_string());
            transaction.add_change(change);
            self.push_transaction(transaction);
        }
    }

    /// Record that a merge region was removed on `sheet` (for undo of unmerge).
    pub fn record_merge_region_removed(&mut self, sheet: usize, region: UndoMergeRegion) {
        let change = CellChange::RemoveMergeRegion { sheet, region };
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

    /// Push a completed transaction onto the undo stack, returning its id.
    fn push_transaction(&mut self, transaction: Transaction) -> u64 {
        // Clear redo stack when new action is performed
        self.redo_stack.clear();
        self.push_back_capped(transaction)
    }

    /// Push a transaction to undo stack without clearing redo.
    /// Used internally by redo operation.
    pub fn push_undo_for_redo(&mut self, transaction: Transaction) {
        self.push_back_capped(transaction);
    }

    /// Stamp an id (first push only) and push, dropping the oldest entries
    /// once the cap is reached -- and COUNTING what was dropped, which is the
    /// only trace an eviction leaves. Returns the id the entry now carries,
    /// which for a re-push (undo then redo) is the one it already had.
    fn push_back_capped(&mut self, mut transaction: Transaction) -> u64 {
        if transaction.seq == 0 {
            transaction.seq = self.next_seq;
            self.next_seq += 1;
        }
        let seq = transaction.seq;
        while self.undo_stack.len() >= self.max_size {
            if self.undo_stack.pop_front().is_none() {
                break;
            }
            self.evicted_total += 1;
        }
        self.undo_stack.push_back(transaction);
        seq
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

    /// The id of the entry a plain `undo` would take back, or `None` when the
    /// history is empty.
    ///
    /// The narrow question `undo_seqs()` answers broadly, for the caller that
    /// only needs "is the thing I just pushed still the thing on top?" — a
    /// command that writes, hands control back, and must later reverse ITS OWN
    /// write and nothing else. Reading the id and popping under one lock is
    /// what makes that check meaningful; two calls with the lock released in
    /// between is the race it exists to close.
    pub fn top_undo_seq(&self) -> Option<u64> {
        self.undo_stack.back().map(|t| t.seq)
    }

    /// How many transactions the cap has dropped over this stack's lifetime.
    pub fn evicted_total(&self) -> u64 {
        self.evicted_total
    }

    /// How many transactions a wholesale `clear()` has discarded over this
    /// stack's lifetime. See the field for why it is not `evicted_total`.
    pub fn cleared_total(&self) -> u64 {
        self.cleared_total
    }

    /// How many times the history has been wholesale cleared, ever. Moves on
    /// EVERY clear, including one that discarded nothing — see the field.
    pub fn clears_total(&self) -> u64 {
        self.clears_total
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

    /// `visit_custom_restores` USED TO BE HERE, and it was deleted rather than
    /// extended (BUG-0005).
    ///
    /// It let the host REWRITE the sheet index inside every queued
    /// `CustomRestore` payload when a sheet operation renumbered the sheets,
    /// on the premise that undo history survives a sheet operation and merely
    /// needs re-aiming. Excel's premise is the opposite one: a change to the
    /// workbook's STRUCTURE ends the undo history outright -- deleting a sheet
    /// is famously not undoable -- and under the project's "Excel parity wins"
    /// rule that is the behaviour Calcula matches. `clear()` at the structural
    /// sheet commands is now the whole answer.
    ///
    /// The two cannot coexist. Re-aiming says "this entry is still valid,
    /// somewhere else"; clearing says "this entry is gone". Keeping the
    /// visitor would leave a second mechanism asserting an invariant the
    /// product no longer holds -- and it only ever covered `CustomRestore`,
    /// never the `SetCell { sheet, .. }` indices sitting beside them in the
    /// same transactions, which is precisely the half that was silently
    /// mis-aiming.
    ///
    /// Clear all history, counting what it discards.
    ///
    /// The count is not bookkeeping. A caller that remembered a transaction id
    /// and can no longer find it has to distinguish "the cap dropped it"
    /// (`evicted_total`) from "a workbook-structure change ended the history"
    /// (`cleared_total`) from "the walk undid past it" (neither counter moved).
    /// Those are three different answers and only the third is ever a product
    /// defect.
    pub fn clear(&mut self) {
        self.cleared_total += (self.undo_stack.len() + self.redo_stack.len()) as u64;
        // Unconditional: a clear that discarded nothing still ENDED the history,
        // and that is the fact a caller needs (see `clears_total`).
        self.clears_total += 1;
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
mod structural_clear_tests {
    //! `clear()` is how a workbook-structure change ends the history (Excel
    //! parity), so the stack has to leave EVIDENCE that it happened. Without
    //! it a caller that remembered a transaction id sees only that the id is
    //! gone, and "gone" has three causes with three different meanings.
    use super::*;

    fn push(stack: &mut UndoStack, n: usize) {
        for i in 0..n {
            stack.record_cell_change(0, i as u32, 0, None);
        }
    }

    #[test]
    fn clear_counts_the_transactions_it_discards() {
        let mut stack = UndoStack::new();
        push(&mut stack, 4);
        // One of them moved to the redo stack: a clear discards that too, and
        // a caller checking the REDO half of a round trip needs it counted.
        let undone = stack.pop_undo().expect("something to undo");
        stack.push_redo(undone);
        assert_eq!(stack.undo_depth(), 3);
        assert_eq!(stack.redo_depth(), 1);

        assert_eq!(stack.cleared_total(), 0, "nothing cleared yet");
        stack.clear();
        assert_eq!(stack.cleared_total(), 4, "3 undo + 1 redo");
        assert!(!stack.can_undo() && !stack.can_redo());
    }

    #[test]
    fn clearing_an_empty_history_is_invisible_and_that_is_correct() {
        // A structural sheet op on a workbook with nothing to undo discards
        // nothing, so it must not look like history was lost -- otherwise
        // every fresh document reports a phantom clear.
        let mut stack = UndoStack::new();
        stack.clear();
        assert_eq!(stack.cleared_total(), 0);
    }

    #[test]
    fn cleared_and_evicted_are_separate_facts() {
        // The whole reason for a second counter: the cap dropping the oldest
        // entry and a sheet operation ending the history are different events
        // with different remedies, and one counter cannot say which occurred.
        let mut stack = UndoStack::with_max_size(3);
        push(&mut stack, 5); // 2 evicted
        assert_eq!(stack.evicted_total(), 2);
        assert_eq!(stack.cleared_total(), 0);

        stack.clear();
        assert_eq!(stack.evicted_total(), 2, "unchanged by a clear");
        assert_eq!(stack.cleared_total(), 3);
    }

    #[test]
    fn a_clear_accumulates_across_repeated_structural_changes() {
        let mut stack = UndoStack::new();
        push(&mut stack, 2);
        stack.clear();
        push(&mut stack, 3);
        stack.clear();
        assert_eq!(stack.cleared_total(), 5);
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

    /// `top_undo_seq` is the narrow question a self-reversing command asks:
    /// "is the thing I just pushed still the thing a plain undo would take?"
    ///
    /// The push hold-back writes, hands control back to the frontend for the
    /// length of a publish, and must then reverse ITS OWN write. Anything that
    /// lands on the stack meanwhile — the author's own edit in a non-modal
    /// dialog, an MCP tool, a sandboxed script — is what a bare `pop_undo` takes
    /// instead, leaving the held-back cells rolled back for good.
    ///
    /// SABOTAGE: return `self.undo_stack.front().map(|t| t.seq)`; the guard then
    /// compares against the OLDEST entry and refuses every correct un-revert
    /// while admitting every wrong one.
    #[test]
    fn the_top_id_is_what_a_plain_undo_would_take() {
        let mut stack = UndoStack::with_max_size(10);
        assert_eq!(stack.top_undo_seq(), None, "an empty history has no top");

        push(&mut stack, 1);
        let mine = stack.top_undo_seq().expect("a push leaves a top");
        assert_eq!(Some(mine), stack.undo_seqs().last().copied());

        // Somebody else writes while my command is between its two halves.
        push(&mut stack, 1);
        assert_ne!(
            stack.top_undo_seq(),
            Some(mine),
            "the top moved — a bare undo here would take back the OTHER write"
        );

        // ...and the entry is still reachable, one step further down. That is
        // the difference between "press Ctrl+Z twice" and "it is gone", and
        // it is the difference the refusal has to tell the user about.
        let seqs = stack.undo_seqs();
        let above = seqs.iter().rposition(|s| *s == mine).map(|i| seqs.len() - 1 - i);
        assert_eq!(above, Some(1));
    }

    /// The same probe, when the remembered entry is gone rather than buried.
    /// No number of undo steps reaches it, and the caller must say so instead
    /// of promising a count.
    #[test]
    fn a_top_id_that_is_gone_is_distinguishable_from_one_that_is_buried() {
        let mut stack = UndoStack::with_max_size(4);
        push(&mut stack, 1);
        let mine = stack.top_undo_seq().unwrap();

        push(&mut stack, 8); // evicts it

        assert_ne!(stack.top_undo_seq(), Some(mine));
        assert!(
            !stack.undo_seqs().contains(&mine),
            "gone, not buried — the remedy is different and so is the sentence"
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

    // -----------------------------------------------------------------------
    // WHICH SHEET DOES THIS TRANSACTION BELONG TO? (undo sheet activation)
    // -----------------------------------------------------------------------

    fn snapshot_on(sheet: usize) -> GridSnapshot {
        GridSnapshot {
            sheet,
            cells: Default::default(),
            row_heights: HashMap::new(),
            column_widths: HashMap::new(),
            merged_regions: HashSet::new(),
            max_row: 0,
            max_col: 0,
            row_styles: HashMap::new(),
            column_styles: HashMap::new(),
        }
    }

    #[test]
    fn target_sheet_is_the_sheet_the_action_happened_on() {
        let mut t = Transaction::new("edit");
        t.add_change(CellChange::SetCell { sheet: 2, row: 4, col: 1, previous: None });
        assert_eq!(t.target_sheet(), Some(2));
    }

    #[test]
    fn target_sheet_reads_every_variant_that_carries_one() {
        for (change, expected) in [
            (CellChange::SetColumnWidth { sheet: 3, col: 0, previous: None }, 3),
            (CellChange::SetRowHeight { sheet: 4, row: 0, previous: None }, 4),
            (
                CellChange::AddMergeRegion {
                    sheet: 5,
                    region: UndoMergeRegion { start_row: 0, start_col: 0, end_row: 1, end_col: 1 },
                },
                5,
            ),
            (
                CellChange::RemoveMergeRegion {
                    sheet: 6,
                    region: UndoMergeRegion { start_row: 0, start_col: 0, end_row: 1, end_col: 1 },
                },
                6,
            ),
            (CellChange::RestoreSnapshot(snapshot_on(7)), 7),
        ] {
            let mut t = Transaction::new("x");
            t.add_change(change);
            assert_eq!(t.target_sheet(), Some(expected));
        }
    }

    #[test]
    fn a_custom_restore_only_transaction_names_no_sheet() {
        // Its sheet lives inside opaque bytes. `None` is the honest answer, and
        // it is what stops the caller falling back to "the active sheet" --
        // the exact sheet-blindness the sheet dimension was added to end.
        let mut t = Transaction::new("comment");
        t.add_change(CellChange::CustomRestore { kind: "comment".into(), data: vec![1, 2, 3] });
        assert_eq!(t.target_sheet(), None);
    }

    #[test]
    fn a_cross_sheet_transaction_names_where_the_action_started() {
        // Recorded order, not application order: a restore replays in reverse,
        // but "where I did that" is the first cell the action wrote.
        let mut t = Transaction::new("batch");
        t.add_change(CellChange::SetCell { sheet: 1, row: 0, col: 0, previous: None });
        t.add_change(CellChange::SetCell { sheet: 2, row: 0, col: 0, previous: None });
        assert_eq!(t.target_sheet(), Some(1));
    }

    #[test]
    fn a_custom_restore_does_not_hide_a_sheet_carrying_change_behind_it() {
        // `find_map` skips the opaque payload rather than stopping at it: a
        // grouped action that records a comment first and a cell second still
        // knows which sheet it belongs to.
        let mut t = Transaction::new("mixed");
        t.add_change(CellChange::CustomRestore { kind: "comment".into(), data: vec![] });
        t.add_change(CellChange::SetCell { sheet: 3, row: 9, col: 9, previous: None });
        assert_eq!(t.target_sheet(), Some(3));
    }

    #[test]
    fn the_anchor_is_the_top_left_cell_restored_on_that_sheet() {
        let mut t = Transaction::new("fill");
        t.add_change(CellChange::SetCell { sheet: 1, row: 9, col: 4, previous: None });
        t.add_change(CellChange::SetCell { sheet: 1, row: 6, col: 7, previous: None });
        t.add_change(CellChange::SetCell { sheet: 2, row: 0, col: 0, previous: None });
        // Row from one change, column from another: the anchor is the corner of
        // the bounding box, which is where Excel puts the selection.
        assert_eq!(t.restored_anchor_on(1), Some((6, 4)));
        assert_eq!(t.restored_anchor_on(2), Some((0, 0)));
        assert_eq!(t.restored_anchor_on(3), None);
    }

    #[test]
    fn a_geometry_only_transaction_has_no_anchor() {
        // A column width describes a whole column and a snapshot the whole
        // sheet; neither names a cell worth aiming the view at.
        let mut t = Transaction::new("resize");
        t.add_change(CellChange::SetColumnWidth { sheet: 1, col: 3, previous: Some(64.0) });
        t.add_change(CellChange::RestoreSnapshot(snapshot_on(1)));
        assert_eq!(t.target_sheet(), Some(1));
        assert_eq!(t.restored_anchor_on(1), None);
        assert_eq!(t.restored_range_on(1), None);
    }

    /// Excel selects the RANGE an undo restored, not its corner: undo a
    /// four-cell paste and all four come back selected (open-items 1.4).
    #[test]
    fn the_range_is_the_bounding_box_of_the_cells_restored_on_that_sheet() {
        let mut t = Transaction::new("paste");
        t.add_change(CellChange::SetCell { sheet: 1, row: 9, col: 4, previous: None });
        t.add_change(CellChange::SetCell { sheet: 1, row: 6, col: 7, previous: None });
        t.add_change(CellChange::SetCell { sheet: 2, row: 0, col: 0, previous: None });
        // Per-axis min and max, INDEPENDENTLY: the box spans rows 6..=9 and
        // columns 4..=7 even though no change sits at (6,4) or (9,7). A
        // selection is a rectangle, so that is Excel's rectangle too.
        assert_eq!(t.restored_range_on(1), Some((6, 4, 9, 7)));
        // A single restored cell is a one-cell range, not a null one.
        assert_eq!(t.restored_range_on(2), Some((0, 0, 0, 0)));
        assert_eq!(t.restored_range_on(3), None);
    }

    /// The anchor is now DERIVED from the range rather than walked separately,
    /// so the two cannot drift into disagreeing about the same transaction --
    /// which would put the active cell outside its own selection.
    #[test]
    fn the_anchor_is_always_the_top_left_corner_of_the_range() {
        let mut t = Transaction::new("fill");
        t.add_change(CellChange::SetCell { sheet: 1, row: 9, col: 4, previous: None });
        t.add_change(CellChange::SetCell { sheet: 1, row: 6, col: 7, previous: None });
        t.add_change(CellChange::SetCell { sheet: 1, row: 7, col: 5, previous: None });
        for sheet in 0..4 {
            assert_eq!(
                t.restored_anchor_on(sheet),
                t.restored_range_on(sheet).map(|(r, c, _, _)| (r, c)),
                "sheet {}",
                sheet
            );
        }
    }
}
