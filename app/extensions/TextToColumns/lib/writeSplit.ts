//! FILENAME: app/extensions/TextToColumns/lib/writeSplit.ts
// PURPOSE: Text to Columns' ONE write path -- the wizard's Finish and the
//          script door (@api/textToColumnsService, splitProvider.ts) both write
//          through here, as one undo step that closes ONLY the undo
//          transaction its own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). Both doors threw the
//          begin's answer away and then committed -- or, on a refusal,
//          cancelled -- whatever was open. The backend has ONE transaction slot
//          and a begin while it is open JOINS it (undo_commands.rs, tickets): a
//          script that split a column inside its own `api.beginBatch` ENDED
//          that batch halfway, and a refused split DROPPED the batch's undo
//          record. One function for both doors, so the wizard and a script can
//          never disagree about it again.

import {
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api";
import type { CellUpdateInput } from "@api";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";

/** The step's closes, read when a close runs (see ownUndoTransaction). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/**
 * Write a split's cells as the "Text to Columns" undo step. Rejects with the
 * BACKEND's reason (it names the refusing cell / region) after closing -- only
 * -- the step this call opened.
 */
export async function writeSplitAsOneStep(updates: CellUpdateInput[]): Promise<void> {
  let tx: OwnedUndoTransaction | null = null;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction("Text to Columns"), UNDO_CLOSES);
    await updateCellsBatch(updates);
    await tx.commit();
  } catch (err) {
    // Close OUR transaction -- left open, later edits silently join it. A
    // joined split closes nothing: its holder (a script's batch) does.
    try { await tx?.cancel(); } catch { /* already closed */ }
    throw err;
  }
}
