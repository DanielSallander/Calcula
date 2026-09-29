//! FILENAME: app/extensions/Controls/lib/shapePropertyStep.ts
// PURPOSE: A script's `shape.setProperty` as ONE undo step -- closing ONLY the
//          undo transaction its own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). The shape:setProperty
//          handler (Controls/index.ts) threw the begin's answer away and then
//          committed -- or, on a failure, cancelled -- whatever was open. The
//          backend has ONE transaction slot and a begin while it is open JOINS
//          it (undo_commands.rs, tickets), and this door is run BY SCRIPTS: a
//          script that set a shape property inside its own `api.beginBatch`
//          ENDED its batch halfway, so its later writes became separate undo
//          steps, and a refused write DROPPED the batch's undo record.

import { beginUndoTransaction, commitUndoTransaction, cancelUndoTransaction } from "@api/lib";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";

/** The step's closes, read when a close runs (see ownUndoTransaction). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/**
 * Run `write` (one shape property's write) as the "Shape property: <key>" undo
 * step. The step is GUARANTEED to close when this call opened it -- committed
 * on success, cancelled on any failure, the commit's own included -- so the
 * engine's transaction can never be left dangling (a dangling transaction
 * silently swallows every subsequent edit). Inside another caller's open
 * transaction the write JOINS it and nothing is closed here. When the undo API
 * itself is unavailable the write still runs, ungrouped. Rejects with the
 * write's (or the commit's) error.
 */
export async function setShapePropertyAsOneStep(key: string, write: () => Promise<unknown>): Promise<void> {
  let tx: OwnedUndoTransaction | null = null;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction("Shape property: " + key), UNDO_CLOSES);
  } catch {
    // Undo-transaction API unavailable; apply the property without grouping.
  }
  try {
    await write();
    await tx?.commit();
  } finally {
    // A no-op after a commit that landed; after a failure (the commit's own
    // included) it closes what this call opened.
    try {
      await tx?.cancel();
    } catch {
      // Best effort -- nothing else can close the transaction.
    }
  }
}
