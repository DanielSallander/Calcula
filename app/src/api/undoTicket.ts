//! FILENAME: app/src/api/undoTicket.ts
// PURPOSE: The @api door to undo-transaction TICKETS. `beginUndoTransaction`
//          answers a ticket when THIS begin OPENED the backend's one
//          transaction slot (null = it joined one another caller holds open),
//          and `commitUndoTransaction(ticket)` / `cancelUndoTransaction(ticket)`
//          close the slot only while it still holds that very transaction. A
//          sheet add / delete / rename / move / copy or a document swap ends
//          the transaction behind its opener's back (Excel parity), and a bare
//          close then landed on whatever a stranger had opened since.
// CONTEXT: The ticket check itself lives in the backend
//          (app/src-tauri/src/undo_commands.rs, "Undo-transaction TICKETS");
//          this module gives extensions the one way to read a begin's answer
//          and -- `ownUndoTransaction` -- to close ONLY what their own begin
//          opened, without importing the whole @api barrel:
//
//            const tx = ownUndoTransaction(await beginUndoTransaction("Sort"), {
//              commitUndoTransaction,
//              cancelUndoTransaction,
//            });
//            try { ...; await tx.commit(); } catch { await tx.cancel(); }
//
//          A gesture that JOINED another caller's transaction (a script's
//          `beginBatch`, a command-line run) closes nothing: its writes are
//          part of that holder's step, and the holder closes it.

export { readUndoBeginAnswer, ownUndoTransaction } from "../core/lib/undoTransactionOwnership";
export type {
  UndoBeginAnswer,
  OwnedUndoTransaction,
  UndoTransactionCloses,
} from "../core/lib/undoTransactionOwnership";
export type { UndoTransactionTicket } from "../core/lib/tauri-api";
