//! FILENAME: app/src/api/pivotOverwrite.ts
// PURPOSE: The ONE "a PivotTable report will overwrite existing data" decision,
//          for EVERY caller of a pivot command -- asked once per user gesture,
//          through `confirmAsync`, awaited and failing CLOSED, and on decline
//          the gesture's overwrite taken back and NOTHING ELSE.
// CONTEXT: A pivot command that grows a worksheet pivot over the user's cells
//          reports it in its response (`overwrittenCellCount`) and records ONE
//          undo step holding those cells, named by `overwriteToken`. The
//          backend's `undo_pivot_overwrite` takes back the step(s) carrying the
//          tokens it is handed -- the WHOLE step, so a slicer click's selection
//          comes back with its pivots -- and REFUSES, popping nothing, when no
//          such step is the last change in the history. It used to pop the top
//          entry unconditionally: a level-1 filter recorded no step, so its
//          Cancel discarded the user's previous, unrelated step, restored
//          nothing and left the cells overwritten.
//
//          WHY IT LIVES IN @api: the gestures that overwrite most often are not
//          the Pivot extension's -- a slicer click (Slicer) and a ribbon filter
//          (ControlsPane) filter pivots through their own backend channels. A
//          prompt wired inside the Pivot extension could not reach them, and
//          importing the Pivot extension from either would break the Seam Rule
//          (the `pivotNotices` precedent). Pivot uses it too, so the question,
//          the refusal and the refresh after a decline exist once.
//
// THE RULES THIS ENFORCES:
//   - Ask AFTER the gesture's undo step has committed, once for all its pivots,
//     naming how many cells. A caller whose work JOINED someone else's open
//     transaction must not ask: it cannot take back only its own part (Ctrl+Z
//     restores the cells with that step). "Someone else's" includes a
//     transaction opened on the BACKEND directly -- a script's `beginBatch` --
//     which the frontend's own flag cannot see: ask
//     {@link isAnyUndoTransactionOpen}, never `isUndoTransactionOpen` alone
//     (fix round 5 review: a click during a script batch committed the batch
//     early, and its decline took back the script's writes).
//   - A dialog that cannot be shown is a DECLINE (confirmAsync fails closed; a
//     rejection here is treated the same).
//   - On decline, take back ONLY the steps the gesture's tokens name. A
//     response that overwrote cells WITHOUT naming a step (a command that
//     records none) cannot be taken back, and the user is told so -- never "undo
//     whatever is on top".
//   - After a take-back, announce what the backend restored, exactly as an undo
//     does (MUTATION_REFRESH with its domains): a slicer's reconcile re-derives
//     the level-1 masks the step did not carry, the pivots repaint.
//
// Seams point one way: this module imports nothing from extensions.

import type { PivotViewResponse } from "./pivotTypes";
import { confirmAsync } from "./dialogs";
import { undoPivotOverwrite } from "./backend";
import { AppEvents, emitAppEvent, type MutationDomain } from "./events";
import { showToast } from "./notifications";
import { isUndoTransactionOpen, runInUndoTransaction } from "./objectGeometry";
import { getUndoState } from "../core/lib/tauri-api";

/** What one gesture's pivot responses overwrote. */
export interface PivotOverwriteTally {
  /** Note one pivot response of the gesture (null / undefined are ignored). */
  note(response: PivotViewResponse | null | undefined): void;
  /** The user's cells the gesture overwrote, over all its pivots. */
  readonly cellCount: number;
  /** The pivots that overwrote cells, in the order they were noted. */
  readonly pivotIds: readonly string[];
  /** The undo steps holding those cells (`overwriteToken`s), in order. */
  readonly tokens: readonly number[];
  /** Some response overwrote cells and named NO step to take back. */
  readonly unrecorded: boolean;
}

/** A fresh tally for one gesture. */
export function createPivotOverwriteTally(): PivotOverwriteTally {
  let cellCount = 0;
  const pivotIds: string[] = [];
  const tokens: number[] = [];
  let unrecorded = false;
  return {
    note(response) {
      const count = response?.overwrittenCellCount ?? 0;
      if (!response || count <= 0) return;
      cellCount += count;
      if (!pivotIds.includes(response.pivotId)) pivotIds.push(response.pivotId);
      const token = response.overwriteToken;
      if (typeof token === "number") {
        if (!tokens.includes(token)) tokens.push(token);
      } else {
        unrecorded = true;
      }
    },
    get cellCount() {
      return cellCount;
    },
    get pivotIds() {
      return pivotIds;
    },
    get tokens() {
      return tokens;
    },
    get unrecorded() {
      return unrecorded;
    },
  };
}

/** The question, naming how many cells (`count` <= 0: Excel's own wording). */
export function pivotOverwriteQuestion(count: number): string {
  if (count <= 0) return "A PivotTable report will overwrite existing data. Do you want to continue?";
  return `A PivotTable report will overwrite existing data in ${count} cell${count === 1 ? "" : "s"}. Do you want to continue?`;
}

/** Why a decline could not take the overwrite back (a toast). */
export const PIVOT_OVERWRITE_NOT_TAKEN_BACK =
  "The PivotTable change could not be taken back, so the overwritten cells were not restored. Use Undo (Ctrl+Z) to step back to it.";

/** How {@link confirmPivotOverwriteOrUndo} ended. */
export type PivotOverwriteOutcome =
  /** Nothing was overwritten: nothing asked. */
  | "none"
  /** The user said OK (the overwrite stands). */
  | "kept"
  /** The user declined and the gesture's overwrite was taken back. */
  | "undone"
  /** The user declined (or could not be asked) and NOTHING could be taken back. */
  | "refused";

/** Options of {@link confirmPivotOverwriteOrUndo}. */
export interface ConfirmPivotOverwriteOptions {
  /**
   * One more undo step to take back AFTER the overwrite steps, by its history
   * id, and only when it is then the last change -- the gesture's own step
   * that its backend records separately BENEATH the pivot step (a ribbon
   * filter's selection). Never anything else.
   */
  thenUndoSeq?: number | null;
}

/**
 * Take back the undo step(s) `tokens` name (and `thenUndoSeq` after them) and
 * announce what came back. Resolves true when something was taken back; on a
 * refusal it tells the user and resolves false. Never throws.
 */
export async function takeBackPivotOverwrite(
  pivotId: string,
  tokens: readonly number[],
  thenUndoSeq?: number | null,
): Promise<boolean> {
  if (tokens.length === 0) {
    showToast(PIVOT_OVERWRITE_NOT_TAKEN_BACK, { type: "error", duration: 8000 });
    return false;
  }
  try {
    const result = await undoPivotOverwrite(pivotId, tokens, thenUndoSeq);
    const domains: MutationDomain[] = ["styles", ...((result?.refreshDomains ?? []) as MutationDomain[])];
    emitAppEvent(AppEvents.MUTATION_REFRESH, { domains, source: "undo" });
    emitAppEvent(AppEvents.GRID_REFRESH);
    if (result && !result.complete) {
      showToast(
        "Part of the PivotTable change could not be taken back: something else changed the workbook in between. Use Undo (Ctrl+Z) for the rest.",
        { type: "error", duration: 8000 },
      );
    }
    return true;
  } catch (err) {
    console.warn("[pivotOverwrite] the overwrite could not be taken back:", err);
    showToast(PIVOT_OVERWRITE_NOT_TAKEN_BACK, { type: "error", duration: 8000 });
    return false;
  }
}

/**
 * Ask ONCE whether the gesture may keep what it overwrote, and on decline take
 * back exactly the gesture's overwrite (see the rules above). Call it AFTER the
 * gesture's undo step has committed, and only for a gesture that opened that
 * step itself.
 */
export async function confirmPivotOverwriteOrUndo(
  tally: PivotOverwriteTally,
  options: ConfirmPivotOverwriteOptions = {},
): Promise<PivotOverwriteOutcome> {
  if (tally.cellCount <= 0) return "none";
  let confirmed = false;
  try {
    confirmed = await confirmAsync(pivotOverwriteQuestion(tally.cellCount), {
      title: "Calcula",
      kind: "warning",
      okLabel: "OK",
      cancelLabel: "Cancel",
    });
  } catch {
    // Fail CLOSED: a question that could not be asked is not a yes.
    confirmed = false;
  }
  if (confirmed) return "kept";
  const undone = await takeBackPivotOverwrite(tally.pivotIds[0] ?? "", tally.tokens, options.thenUndoSeq);
  // Some pivot of the gesture overwrote cells WITHOUT a step to take back:
  // those stay overwritten, and the user must not be left believing otherwise.
  if (undone && tally.unrecorded) {
    showToast(PIVOT_OVERWRITE_NOT_TAKEN_BACK, { type: "error", duration: 8000 });
  }
  return undone ? "undone" : "refused";
}

/**
 * Whether an undo transaction is open ANYWHERE right now: the frontend's own
 * (`isUndoTransactionOpen`), or one opened on the backend directly. A script's
 * `api.beginBatch` goes straight to the backend's `begin_undo_transaction`,
 * so the frontend flag never sees it; and the backend's begin is a no-op while
 * a transaction is open, so a gesture that "opens" its step then silently
 * JOINS the script's batch -- its commit closes the batch, and a decline would
 * take back the script's writes along with the gesture's.
 *
 * Read it right BEFORE the gesture opens its step (the frontend flag is read
 * after the backend round trip, so it is current). A backend state that cannot
 * be read counts as OPEN: a gesture that cannot prove its step is its own must
 * not offer to take it back -- Ctrl+Z still restores the cells with that step.
 */
export async function isAnyUndoTransactionOpen(): Promise<boolean> {
  let backendOpen: boolean;
  try {
    const state = await getUndoState();
    backendOpen = state?.transactionOpen !== false;
  } catch {
    backendOpen = true;
  }
  return backendOpen || isUndoTransactionOpen();
}

/** How {@link runStepThenConfirmOverwrite} ended: the question's outcome, or
 *  "joined" -- the gesture ran inside someone else's open transaction, so
 *  nothing was asked (and nothing may be taken back). */
export type PivotOverwriteStepOutcome = PivotOverwriteOutcome | "joined";

/**
 * Run ONE user gesture as ONE undo step labelled `label` -- `body` gets the
 * gesture's tally to note every pivot response into -- and, once that step has
 * committed, ask ONCE about everything it overwrote
 * ({@link confirmPivotOverwriteOrUndo}). A gesture that would JOIN an open
 * transaction ({@link isAnyUndoTransactionOpen}) runs inside it and never
 * asks. The body's rejection propagates (after the step committed; nothing is
 * asked). The one wiring of the rule for every gesture that opens its own
 * step, so the "joined" check cannot drift between them again.
 */
export async function runStepThenConfirmOverwrite<T>(
  label: string,
  body: (overwrites: PivotOverwriteTally) => Promise<T>,
): Promise<{ result: T; outcome: PivotOverwriteStepOutcome }> {
  const joined = await isAnyUndoTransactionOpen();
  const overwrites = createPivotOverwriteTally();
  const result = await runInUndoTransaction(label, () => body(overwrites));
  if (joined) return { result, outcome: "joined" };
  return { result, outcome: await confirmPivotOverwriteOrUndo(overwrites) };
}

/**
 * The one step a write pushed, read from the undo history ids before and after
 * it (`UndoState.undoSeqs`, oldest first): the new top when EXACTLY one entry
 * appeared on top of the old one, else null. Conservative by construction --
 * two entries, a cleared history or an unchanged top all answer null, so a
 * caller never names a step it cannot prove is its own. Pure.
 */
export function undoStepPushedBetween(before: readonly number[], after: readonly number[]): number | null {
  if (after.length === 0) return null;
  const top = after[after.length - 1];
  if (before.includes(top)) return null;
  const below = after.length >= 2 ? after[after.length - 2] : undefined;
  const oldTop = before.length > 0 ? before[before.length - 1] : undefined;
  return below === oldTop ? top : null;
}

/** The history ids, oldest first, or null when they cannot be read or a
 *  transaction is OPEN (a write then joins someone else's step and pushes
 *  none of its own, so nothing it pushes can be proven its own). */
async function readOwnUndoSeqs(): Promise<number[] | null> {
  try {
    const state = await getUndoState();
    if (!state || state.transactionOpen || !Array.isArray(state.undoSeqs)) return null;
    return state.undoSeqs;
  } catch {
    return null;
  }
}

/**
 * Run `write` -- a backend write that records exactly one undo step of its
 * own -- and name that step (its history id) when it can be PROVEN to be the
 * write's: exactly one entry appeared on top, with no transaction open before
 * or after. Otherwise `seq` is null and the caller names nothing. For a
 * gesture whose backend records a step BENEATH its pivot step (a ribbon
 * filter's selection), handed to {@link confirmPivotOverwriteOrUndo} as
 * `thenUndoSeq`. The write's own rejection propagates.
 */
export async function runNamingItsUndoStep<T>(write: () => Promise<T>): Promise<{ result: T; seq: number | null }> {
  const before = await readOwnUndoSeqs();
  const result = await write();
  const after = before === null ? null : await readOwnUndoSeqs();
  return { result, seq: before !== null && after !== null ? undoStepPushedBetween(before, after) : null };
}
