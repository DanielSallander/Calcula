//! FILENAME: app/e2e/oracles/undoRoundTrip.ts
// PURPOSE: Undo round-trip oracle. After any sequence of actions:
//          undo-all-back-to-baseline must restore the baseline state, and
//          redo-all must restore the post-action state. Catches missing or
//          wrong undo registrations and state corruption — a class of bug
//          invisible to the existing shallow invariants.
//
// Undo/redo are invoked directly on the Tauri backend (not via Ctrl+Z) for
// determinism. The frontend is not notified during the round-trip; since the
// state ends up exactly where it started (undo N -> redo N), the frontend
// stays consistent with the final state. A grid:refresh is dispatched at the
// end as a repaint safety net.
//
// HOW FAR BACK IS "BACK TO THE BASELINE"
// --------------------------------------
// This oracle used to answer that with `undoDepth_now - undoDepth_baseline`,
// and that arithmetic is WRONG in a way that only shows up on long walks.
// Undo history is capped (100 entries, as in Excel). Once the cap is reached
// every further push silently drops the OLDEST entry and the depth stops
// growing — so the difference under-counts by exactly the number evicted, the
// oracle stops short, and whatever the walk did at the START of the window is
// still applied when the digests are compared. It then reports that as an undo
// defect.
//
// That is not a hypothetical. It is S12: seed 20260810 reported "an un-undone
// cell edit" and "a table restored that the checkpoint never had", and both
// leftovers were the oldest actions of the window — the signature of stopping
// early, not of a broken inverse. (The third leftover in that report,
// conditional formatting, was a real defect and is fixed.) It is also the most
// likely reading of S11, where backend sparkline undo/redo measured symmetric
// in isolation and "needed another action class to trigger" — i.e. needed
// enough other actions to fill the history.
//
// So the question is now asked in terms of IDENTITY, not size. The backend
// stamps every transaction with a monotonic id and reports the ids on the
// stack (`undoSeqs`). The baseline remembers the id on top; the checkpoint
// finds that id and counts the entries above it. If the id is gone — evicted
// by the cap, or undone past by the walk itself — the baseline state is
// unreachable and no number of undo steps restores it, so the oracle says so
// (`undo-history-unreachable`) instead of blaming the product.
//
// A THIRD WAY THE ID CAN BE GONE, and it is the one BUG-0005 was filed as
// -------------------------------------------------------------------------
// A change to the workbook's SHEET STRUCTURE ends the undo history outright.
// Excel does not let adding, deleting, renaming, moving or copying a sheet be
// undone — deleting a worksheet is the documented case, and the Undo command
// goes unavailable after it — and Calcula matches that under the standing
// "Excel parity wins" rule. So a walk that adds a sheet mid-window has ended
// the history it would have to wind back through, and no product defect is
// involved.
//
// This oracle could not see that. `sheet.add` at action 35 of soak seed 424242
// came back as "undo-all did not restore the checkpoint: 14 digest differences"
// — a report about undo, produced by an action Excel would not let you undo.
// The backend now counts wholesale clears separately from cap evictions
// (`clearedTotal` vs `evictedTotal`), so the three causes are tellable apart
// and only the third — the walk undoing past its own checkpoint — is ever
// reported as anything other than "outside the history".

import type { Page } from "@playwright/test";
import { getWorkbookDigest, diffDigests } from "./digest";
import type { OracleBaseline, OracleViolation } from "./types";

interface UndoStateJson {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
  undoDepth: number;
  redoDepth: number;
  /** History ids on the undo stack, oldest first. */
  undoSeqs: number[];
  /** Transactions the size cap has dropped over this document's lifetime. */
  evictedTotal: number;
  /** Transactions a wholesale clear has discarded over this document's
   *  lifetime — i.e. a workbook-STRUCTURE change ended the history. */
  clearedTotal: number;
  /** The history cap. */
  historyLimit: number;
}

export async function getUndoState(page: Page): Promise<UndoStateJson> {
  return (await page.evaluate(() => {
    const tauri = (window as any).__TAURI__;
    return tauri.core.invoke("get_undo_state");
  })) as UndoStateJson;
}

/** Capture the baseline for a new checkpoint window. */
export async function captureUndoBaseline(page: Page): Promise<OracleBaseline> {
  const [digest, undoState] = [
    await getWorkbookDigest(page),
    await getUndoState(page),
  ];
  return {
    digest,
    undoDepth: undoState.undoDepth,
    // The id on top of the stack right now. `null` when the stack is empty,
    // which is a distinct and perfectly reachable state: everything currently
    // on the stack is then post-baseline.
    undoTopSeq: undoState.undoSeqs.length
      ? undoState.undoSeqs[undoState.undoSeqs.length - 1]
      : null,
    evictedTotal: undoState.evictedTotal,
    clearedTotal: undoState.clearedTotal ?? 0,
  };
}

/**
 * How many undo steps return the workbook to `baseline`, or why none does.
 *
 * Exported and pure so its behaviour can be reasoned about (and tested)
 * without a running app: everything it needs is the two readings.
 */
export function stepsBackToBaseline(
  baseline: Pick<OracleBaseline, "undoTopSeq" | "evictedTotal" | "clearedTotal">,
  now: Pick<UndoStateJson, "undoSeqs" | "evictedTotal" | "clearedTotal">
): { steps: number } | { unreachable: string } {
  // A WHOLESALE CLEAR IS ASKED ABOUT FIRST, because it is the only one of the
  // three causes that can empty the stack without either of the other two
  // leaving a trace — and it is the one the oracle used to misread. Excel does
  // not let a change to the workbook's sheet STRUCTURE be undone: adding,
  // deleting, renaming, moving or copying a sheet ends the undo history, and
  // Calcula matches that (BUG-0005). A walk that does any of those inside a
  // checkpoint window cannot be wound back to the checkpoint, and saying so is
  // not the same as saying undo is broken. Before this, the walk's sheet.add
  // came back as "the walk undid past the checkpoint" — a diagnosis naming a
  // mechanism that had not occurred.
  const cleared = now.clearedTotal - (baseline.clearedTotal ?? 0);
  const clearedReason =
    `a workbook-structure change ended the undo history since the checkpoint ` +
    `(${cleared} transaction(s) discarded). Adding, deleting, renaming, moving ` +
    `or copying a sheet is not undoable in Excel and clears the stack here too, ` +
    `so no number of undo steps returns to the checkpoint`;

  if (baseline.undoTopSeq === null || baseline.undoTopSeq === undefined) {
    // Nothing was on the stack at the baseline, so every entry now is
    // post-baseline — unless something has removed entries since, which is the
    // one case an empty baseline cannot distinguish on its own.
    if (cleared > 0) {
      return { unreachable: clearedReason };
    }
    if (now.evictedTotal !== baseline.evictedTotal) {
      return {
        unreachable:
          `the undo history was empty at the checkpoint and the size cap has ` +
          `since dropped ${now.evictedTotal - (baseline.evictedTotal ?? 0)} ` +
          `transaction(s), so the checkpoint state is no longer on the stack`,
      };
    }
    return { steps: now.undoSeqs.length };
  }

  const position = now.undoSeqs.indexOf(baseline.undoTopSeq);
  if (position < 0) {
    if (cleared > 0) {
      return {
        unreachable:
          `the checkpoint's top undo entry (#${baseline.undoTopSeq}) is gone: ` +
          clearedReason,
      };
    }
    const evicted = now.evictedTotal - (baseline.evictedTotal ?? 0);
    return {
      unreachable:
        evicted > 0
          ? `the checkpoint's top undo entry (#${baseline.undoTopSeq}) has been ` +
            `dropped by the ${evicted}-transaction overflow of the history cap`
          : `the checkpoint's top undo entry (#${baseline.undoTopSeq}) is no ` +
            `longer on the stack — the walk undid past the checkpoint and a ` +
            `later action cleared the redo stack`,
    };
  }
  return { steps: now.undoSeqs.length - 1 - position };
}

/** Invoke backend undo/redo `count` times; returns how many succeeded. */
async function invokeSteps(
  page: Page,
  command: "undo" | "redo",
  count: number
): Promise<number> {
  return (await page.evaluate(
    async ({ command, count }) => {
      const tauri = (window as any).__TAURI__;
      let done = 0;
      for (let i = 0; i < count; i++) {
        try {
          const result = await tauri.core.invoke(command);
          if (result && result.success === false) break;
          done++;
        } catch {
          break;
        }
      }
      return done;
    },
    { command, count }
  )) as number;
}

async function refreshGrid(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("grid:refresh"));
  });
}

/**
 * Run the undo round-trip against a baseline captured before the actions of
 * this checkpoint window.
 *
 * Flow: D_after = digest -> undo back to the baseline entry -> compare with
 * baseline digest -> redo the same number of steps -> compare with D_after.
 */
export async function checkUndoRoundTrip(
  page: Page,
  baseline: OracleBaseline
): Promise<OracleViolation[]> {
  const violations: OracleViolation[] = [];

  const after = await getWorkbookDigest(page);
  const undoState = await getUndoState(page);
  const distance = stepsBackToBaseline(baseline, undoState);

  if ("unreachable" in distance) {
    // NOT a product defect, and deliberately not reported as one. The history
    // no longer reaches the checkpoint, so there is nothing this oracle can
    // decide about this window; saying "undo is broken" here is exactly the
    // false report that cost S11/S12 a triage cycle each.
    return [
      {
        invariantId: "undo-history-unreachable",
        oracleId: "undo-round-trip",
        message:
          `Undo round-trip skipped: ${distance.unreachable}. ` +
          `Not an undo defect — the checkpoint is outside the history the ` +
          `stack still holds (limit ${undoState.historyLimit}).`,
        details: {
          baselineTopSeq: baseline.undoTopSeq,
          currentDepth: undoState.undoDepth,
          evictedSinceBaseline: undoState.evictedTotal - (baseline.evictedTotal ?? 0),
          // Non-zero means a sheet was added/deleted/renamed/moved/copied in
          // this window and the history ended there (Excel parity).
          clearedSinceBaseline: undoState.clearedTotal - (baseline.clearedTotal ?? 0),
          historyLimit: undoState.historyLimit,
        },
      },
    ];
  }

  const stepsToUndo = distance.steps;
  if (stepsToUndo === 0) {
    // Nothing undoable happened in this window — trivially consistent.
    //
    // Printed, because "trivially consistent" and "verified consistent" look
    // IDENTICAL in a green report and they are not the same evidence. A run
    // whose windows are all zero passed this oracle without ever exercising
    // it, and that has to be readable from the log rather than assumed away.
    // This is the same reason `undecided` is collected instead of dropped:
    // both are ways the round-trip silently stops testing anything.
    console.log("  [oracle] undo round-trip: nothing undoable in this window");
    return [];
  }

  // How far this checkpoint actually wound the history back. A green run that
  // only ever undid one transaction per window is much weaker evidence than
  // one that wound back thirty, and the difference was previously invisible.
  console.log(`  [oracle] undo round-trip: winding back ${stepsToUndo} transaction(s)`);

  // ---- Undo back to the baseline ----
  const undone = await invokeSteps(page, "undo", stepsToUndo);
  if (undone < stepsToUndo) {
    violations.push({
      invariantId: "undo-depth-mismatch",
      oracleId: "undo-round-trip",
      message:
        `Expected to undo ${stepsToUndo} steps but only ${undone} succeeded ` +
        `(canUndo exhausted early).`,
      details: { expected: stepsToUndo, actual: undone },
    });
  }

  const undoneDigest = await getWorkbookDigest(page);
  const undoDiff = diffDigests(baseline.digest, undoneDigest, "undo");
  if (!undoDiff.equal) {
    violations.push({
      invariantId: "undo-round-trip",
      oracleId: "undo-round-trip",
      message:
        `Undoing ${undone} steps did not restore the checkpoint state. ` +
        `${undoDiff.diffs.length}${undoDiff.truncated ? "+" : ""} differences; ` +
        `first: ${formatFirstDiff(undoDiff.diffs)}`,
      details: { stepsUndone: undone },
      digestDiff: undoDiff,
    });
  }

  // ---- Redo back to the post-action state ----
  const redone = await invokeSteps(page, "redo", undone);
  if (redone < undone) {
    violations.push({
      invariantId: "undo-depth-mismatch",
      oracleId: "undo-round-trip",
      message: `Expected to redo ${undone} steps but only ${redone} succeeded.`,
      details: { expected: undone, actual: redone },
    });
  }

  const redoneDigest = await getWorkbookDigest(page);
  const redoDiff = diffDigests(after, redoneDigest, "undo");
  if (!redoDiff.equal) {
    violations.push({
      invariantId: "undo-round-trip",
      oracleId: "undo-round-trip",
      message:
        `Redoing ${redone} steps did not restore the post-action state. ` +
        `${redoDiff.diffs.length}${redoDiff.truncated ? "+" : ""} differences; ` +
        `first: ${formatFirstDiff(redoDiff.diffs)}`,
      details: { stepsRedone: redone },
      digestDiff: redoDiff,
    });
  }

  await refreshGrid(page);
  return violations;
}

function formatFirstDiff(
  diffs: Array<{ path: string; before: unknown; after: unknown }>
): string {
  if (diffs.length === 0) return "(none)";
  const d = diffs[0];
  return `${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`;
}
