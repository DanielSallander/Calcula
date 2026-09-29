//! FILENAME: app/extensions/Consolidate/lib/consolidateAsOneStep.ts
// PURPOSE: Data Consolidation's write as ONE undo step -- closing ONLY the undo
//          transaction its own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). The dialog's OK threw the
//          begin's answer away and then committed -- or, on a failure,
//          cancelled -- whatever was open. The backend has ONE transaction slot
//          and a begin while it is open JOINS it (undo_commands.rs, tickets): a
//          consolidation run while a script held `api.beginBatch` ENDED the
//          script's batch halfway, and a failed one DROPPED the batch's undo
//          record. Out of the component so the rule is testable without a
//          render (__tests__/consolidateUndoOwnership.test.ts).

import {
  consolidateData,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api";
import type { ConsolidateParams, ConsolidateResult } from "@api";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";

/** The step's closes, read when a close runs (see ownUndoTransaction). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/**
 * Run one consolidation as the "Data Consolidation" undo step. Resolves the
 * backend's result (which may itself report `success: false`); REJECTS when the
 * backend refused, after closing -- only -- the step this call opened.
 */
export async function consolidateAsOneStep(params: ConsolidateParams): Promise<ConsolidateResult> {
  let tx: OwnedUndoTransaction | null = null;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction("Data Consolidation"), UNDO_CLOSES);
    const result = await consolidateData(params);
    await tx.commit();
    return result;
  } catch (err) {
    // Close OUR transaction -- left open, every subsequent edit silently joins
    // it and collapses into one Ctrl+Z step. A joined run closes nothing.
    try { await tx?.cancel(); } catch { /* already closed */ }
    throw err;
  }
}
