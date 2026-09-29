//! FILENAME: app/extensions/CsvImportExport/lib/csvImportWrite.ts
// PURPOSE: The CSV Import wizard's write as ONE undo step -- closing ONLY the
//          undo transaction its own begin OPENED.
// CONTEXT: Z6 (wave F; wave E core fix-up NEEDS 1). The wizard's Import threw
//          the begin's answer away and then committed -- or, on a refusal,
//          cancelled -- whatever was open. The backend has ONE transaction
//          slot and a begin while it is open JOINS it (undo_commands.rs,
//          tickets): an import run while a script held `api.beginBatch` ENDED
//          the script's batch halfway, and a refused import DROPPED the batch's
//          undo record. Out of the component so the rule is testable without a
//          render (__tests__/csvImportUndoOwnership.test.ts).

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

/** Writes are sent in chunks so one import cannot overwhelm the backend. */
const CHUNK_SIZE = 5000;

/**
 * The cells an import writes from A1 of the active sheet: the header row (when
 * there is one) on the first row, then every data row; empty data fields are
 * not written.
 */
export function buildCsvImportUpdates(headerRow: string[] | null, dataRows: string[][]): CellUpdateInput[] {
  const updates: CellUpdateInput[] = [];
  let writeRow = 0;

  if (headerRow) {
    for (let c = 0; c < headerRow.length; c++) {
      updates.push({ row: writeRow, col: c, value: headerRow[c] });
    }
    writeRow++;
  }

  for (const row of dataRows) {
    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val !== "") {
        updates.push({ row: writeRow, col: c, value: val });
      }
    }
    writeRow++;
  }
  return updates;
}

/**
 * Write one import as the "CSV Import" undo step. Rejects when the backend
 * refused a chunk, after closing -- only -- the step this call opened.
 */
export async function writeCsvImportAsOneStep(headerRow: string[] | null, dataRows: string[][]): Promise<void> {
  let tx: OwnedUndoTransaction | null = null;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction("CSV Import"), UNDO_CLOSES);
    const updates = buildCsvImportUpdates(headerRow, dataRows);
    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      await updateCellsBatch(updates.slice(i, i + CHUNK_SIZE));
    }
    await tx.commit();
  } catch (err) {
    // Close OUR "CSV Import" transaction -- left open, every subsequent edit
    // silently joins it and collapses into one Ctrl+Z step. A joined import
    // closes nothing: its holder does.
    try { await tx?.cancel(); } catch { /* already closed */ }
    throw err;
  }
}
