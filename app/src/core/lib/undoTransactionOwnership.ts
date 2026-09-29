//! FILENAME: app/src/core/lib/undoTransactionOwnership.ts
// PURPOSE: Close ONLY the undo transaction your own begin OPENED. A gesture
//          (a paste, a fill, a column resize, a Format Painter stroke, an
//          AutoFilter sort) groups its writes into one undo step by bracketing
//          them with begin / commit -- but the backend has ONE transaction
//          slot, and a begin while it is open JOINS it. A script that holds
//          `api.beginBatch`, a command-line run or another gesture in flight
//          holds that slot; a gesture that then committed (or cancelled)
//          unconditionally closed THEIR step halfway: the script's later writes
//          became separate undo steps, and a cancel dropped the holder's undo
//          record outright (wave D, undo report NEW defect 2).
// CONTEXT: `begin_undo_transaction` answers a TICKET when that begin OPENED the
//          transaction and `null` when it JOINED one (undo_commands.rs,
//          "Undo-transaction TICKETS"). `ownUndoTransaction` reads that answer
//          once and hands back the only two closes the caller is entitled to:
//          they close nothing after a join, and after an opening begin they
//          PRESENT the ticket, so the backend closes the slot only while it
//          still holds that very transaction.
//
//          PURE on purpose -- no IPC of its own. The caller passes the commit
//          and cancel it already imports (tauri-api, `@api/lib`, `@api`), so
//          a test that doubles those doubles every close this helper makes, and
//          this module stays importable where tauri-api is mocked wholesale.

import type { UndoTransactionTicket } from "./tauri-api";

/** A begin's answer, read: did it open the transaction, and with what ticket. */
export interface UndoBeginAnswer {
  opened: boolean;
  /** The ticket to close with; `null` when joined -- or when an opening begin
   *  was answered without one (then the close presents none). */
  ticket: UndoTransactionTicket | null;
}

/**
 * Read what `beginUndoTransaction` resolved. A number is an OPENING begin's
 * ticket; `null` (or `false`) is a join. Anything else -- no answer at all --
 * counts as OPENED and is closed without a ticket: a transaction nobody closes
 * swallows every later edit into it, so the doubt fails toward closing.
 */
export function readUndoBeginAnswer(answer: unknown): UndoBeginAnswer {
  if (typeof answer === "number") return { opened: true, ticket: answer };
  if (answer === null || answer === false) return { opened: false, ticket: null };
  return { opened: true, ticket: null };
}

/** The commit and cancel an owned transaction closes through (the caller's own). */
export interface UndoTransactionCloses {
  commitUndoTransaction(ticket?: UndoTransactionTicket | null): Promise<void>;
  cancelUndoTransaction(ticket?: UndoTransactionTicket | null): Promise<void>;
}

/**
 * One gesture's hold on the undo transaction its begin asked for.
 *
 * `commit()` / `cancel()` close the transaction ONLY when this begin opened it,
 * presenting its ticket; after a JOIN both are no-ops -- the writes already
 * belong to the holder's step, and the holder (a script's batch, a CLI run, an
 * outer gesture) closes it. A cancel never drops a holder's undo record, and a
 * commit never ends a holder's step early. Once a close has LANDED, a later
 * commit or cancel on the same hold does nothing; a close that threw leaves the
 * hold open, so the caller's cleanup cancel still gets its one try (with the
 * ticket, a close whose transaction is gone already closes nothing).
 */
export interface OwnedUndoTransaction {
  /** This begin OPENED the transaction (false: it joined one another caller holds). */
  readonly opened: boolean;
  /** The ticket the closes present; null after a join, or after an opening
   *  begin that was answered without one. */
  readonly ticket: UndoTransactionTicket | null;
  /** Commit what this begin opened -- nothing after a join. */
  commit(): Promise<void>;
  /** Cancel what this begin opened (its undo record is DROPPED; its writes
   *  stay) -- nothing after a join. */
  cancel(): Promise<void>;
}

/**
 * Read a begin's `answer` and bind it to the caller's commit / cancel:
 *
 * ```ts
 * const tx = ownUndoTransaction(await beginUndoTransaction("Paste 4 cells"), {
 *   commitUndoTransaction,
 *   cancelUndoTransaction,
 * });
 * try { ...writes...; await tx.commit(); } catch (e) { await tx.cancel(); }
 * ```
 */
export function ownUndoTransaction(answer: unknown, closes: UndoTransactionCloses): OwnedUndoTransaction {
  const own = readUndoBeginAnswer(answer);
  let closed = !own.opened;
  const close = async (which: "commit" | "cancel"): Promise<void> => {
    if (closed) return;
    const fn = which === "commit" ? closes.commitUndoTransaction : closes.cancelUndoTransaction;
    // Bare when the opening begin gave no ticket: the close must still land,
    // or the transaction swallows every later edit (readUndoBeginAnswer).
    await (own.ticket === null ? fn() : fn(own.ticket));
    closed = true;
  };
  return {
    opened: own.opened,
    ticket: own.ticket,
    commit: () => close("commit"),
    cancel: () => close("cancel"),
  };
}
