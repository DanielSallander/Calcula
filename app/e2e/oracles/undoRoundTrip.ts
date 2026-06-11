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
  return { digest, undoDepth: undoState.undoDepth };
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
 * Flow: D_after = digest -> undo back to baseline depth -> compare with
 * baseline digest -> redo the same number of steps -> compare with D_after.
 */
export async function checkUndoRoundTrip(
  page: Page,
  baseline: OracleBaseline
): Promise<OracleViolation[]> {
  const violations: OracleViolation[] = [];

  const after = await getWorkbookDigest(page);
  const undoState = await getUndoState(page);
  const stepsToUndo = undoState.undoDepth - baseline.undoDepth;

  if (stepsToUndo < 0) {
    // The stack shrank below the baseline (cleared by some action?). The
    // round-trip cannot run; report as a low-severity bookkeeping violation.
    return [
      {
        invariantId: "undo-depth-mismatch",
        oracleId: "undo-round-trip",
        message:
          `Undo stack depth (${undoState.undoDepth}) is below the checkpoint ` +
          `baseline (${baseline.undoDepth}) — some action cleared undo history.`,
        details: {
          baselineDepth: baseline.undoDepth,
          currentDepth: undoState.undoDepth,
        },
      },
    ];
  }

  if (stepsToUndo === 0) {
    // Nothing undoable happened in this window — trivially consistent.
    return [];
  }

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
