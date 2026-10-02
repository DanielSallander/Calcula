//! FILENAME: app/src/core/lib/merge/mergeGestures.ts
// PURPOSE: Excel's four Merge commands as gestures over the selection:
//          Merge & Center (a toggle), Merge Across, Merge Cells, Unmerge Cells.
// CONTEXT: Why this sits in Core rather than an extension: these are the
//          handlers behind the grid commands `mergeCenter` / `mergeAcross` /
//          `mergeCells` / `unmergeCells`, which Core's Spreadsheet registers the
//          way it registers Clear All and Insert/Delete (CLAUDE.md rule 5's
//          precedent for grid gestures). The ribbon, Ctrl+M and scripts all
//          reach them through the ONE grid-command door, so every entry point
//          gets the same warning, refusals and undo step.
//
// THE RULES (Excel, observed live in Microsoft 365 build 20326, 2026-10-02):
// - Each Ctrl+click block is handled on its own; two blocks that OVERLAP make
//   the three merge commands do nothing at all, silently.
// - Merge & Center is a TOGGLE: while any merged cell lies in the selection it
//   UNMERGES every merge there and sets horizontal alignment to General over
//   the former merged areas; it never merges in that state. Otherwise it merges
//   each block and centres it; a one-cell block is only centred.
// - Merge Across merges each ROW of each block; Merge Cells merges each block,
//   absorbing merges inside it; neither touches alignment.
// - Unmerge Cells unmerges every merge in the selection and keeps alignment.
// - When a merge would discard values, Excel warns ONCE ("Merging cells only
//   keeps the upper-left value..."): Cancel changes nothing at all. Excel asks
//   once per block (once per row for Merge Across); both give the same two
//   outcomes -- everything or nothing -- so one question is asked.
// - A region whose top-left cell is empty takes the first value in reading
//   order, and formulas that read that value are re-pointed to it.
// - Every command is ONE undo step.
// - Refused on a protected sheet (Excel disables the control there).

import type { Selection } from "../../types";
import {
  applyFormatting,
  beginUndoTransaction,
  cancelUndoTransaction,
  commitUndoTransaction,
  getMergedRegions,
  isActiveSheetProtected,
  mergeCells,
  relocateCellReferences,
  unmergeCells,
} from "../tauri-api";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "../undoTransactionOwnership";
import { alertAsync, confirmAsync } from "../dialogs";
import { cellEvents } from "../cellEvents";
import type { MergedRegion, MergeOptions, MovedCell } from "../../types";
import {
  blocksOverlap,
  boundingBox,
  cellCount,
  colsOf,
  isSingleCell,
  regionsTouching,
  rowsOf,
  selectionBlocks,
  type Block,
} from "./mergeGeometry";
import {
  MERGE_ALIGN_CELL_LIMIT,
  MERGE_DISCARDS_VALUES,
  MERGE_LABELS,
  MERGE_ON_PROTECTED_SHEET,
  type MergeGestureKind,
} from "./mergeText";

/** What a gesture needs from the grid that runs it. */
export interface MergeGestureHost {
  /** The selection the gesture acts on. */
  selection: Selection | null;
  /** Repaint after the change (re-read cells, redraw, announce). */
  refresh(): Promise<void>;
}

/** The closes an owned transaction uses, read when the close runs. */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/**
 * ONE gesture at a time. A double click on the button would otherwise probe
 * twice and could show two warnings, and the second gesture's begin would JOIN
 * the first one's transaction -- so its later writes would land outside the
 * first one's commit. A second call while one runs is ignored.
 */
let inFlight = false;

/** Whether a merge gesture is running (exported for tests). */
export function isMergeGestureRunning(): boolean {
  return inFlight;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Write a horizontal alignment to `area`: every cell when it is small enough,
 * else only its top-left cell (see MERGE_ALIGN_CELL_LIMIT -- the merged cell
 * is drawn from its top-left cell's style, so the result looks the same).
 */
async function alignArea(area: Block | MergedRegion, textAlign: "center" | "general"): Promise<void> {
  if (cellCount(area) <= MERGE_ALIGN_CELL_LIMIT) {
    await applyFormatting(rowsOf(area), colsOf(area), { textAlign });
  } else {
    await applyFormatting([Math.min(area.startRow, area.endRow)], [Math.min(area.startCol, area.endCol)], {
      textAlign,
    });
  }
}

/**
 * Run one of Excel's Merge commands over `host.selection`. Never throws:
 * every refusal reaches the user as an alert (the old handlers sent them to
 * the console, so a refused merge looked like a dead button).
 */
export async function runMergeGesture(kind: MergeGestureKind, host: MergeGestureHost): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await runGesture(kind, host);
  } finally {
    inFlight = false;
  }
}

async function runGesture(kind: MergeGestureKind, host: MergeGestureHost): Promise<void> {
  const blocks = selectionBlocks(host.selection);
  const box = boundingBox(blocks);
  if (!box) return;

  let protectedSheet: boolean;
  try {
    protectedSheet = await isActiveSheetProtected();
  } catch (error) {
    await alertAsync(messageOf(error));
    return;
  }
  if (protectedSheet) {
    await alertAsync(MERGE_ON_PROTECTED_SHEET);
    return;
  }

  let touching: MergedRegion[];
  try {
    touching = regionsTouching(blocks, await getMergedRegions(box));
  } catch (error) {
    await alertAsync(messageOf(error));
    return;
  }

  const label = MERGE_LABELS[kind];
  if (kind === "unmergeCells" || (kind === "mergeCenter" && touching.length > 0)) {
    // Unmerging is never refused for overlapping blocks: the union of the
    // blocks is unmerged (Excel's no-op on overlap applies to MERGING).
    if (touching.length === 0) return;
    await unmergeBlocks(blocks, label, kind === "mergeCenter", host);
    return;
  }

  // Merge: overlapping blocks make Excel do nothing, silently.
  if (blocksOverlap(blocks)) return;
  await mergeBlocks(kind, blocks, label, host);
}

/** Unmerge every merge in the blocks; the toggle also resets alignment. */
async function unmergeBlocks(
  blocks: Block[],
  label: string,
  resetAlignment: boolean,
  host: MergeGestureHost,
): Promise<void> {
  let tx: OwnedUndoTransaction | null = null;
  let applied = false;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction(label), UNDO_CLOSES);
    const removed: MergedRegion[] = [];
    for (const b of blocks) {
      const result = await unmergeCells(b.startRow, b.startCol, undefined, { endRow: b.endRow, endCol: b.endCol });
      if (result?.success) {
        applied = true;
        removed.push(...(result.removedRegions ?? []));
      }
    }
    // Excel's toggle: General alignment over the FORMER MERGED AREAS only;
    // the other selected cells keep theirs. Unmerge Cells keeps alignment.
    if (resetAlignment) {
      for (const r of removed) await alignArea(r, "general");
    }
    await tx.commit();
  } catch (error) {
    await closeAfterFailure(tx, applied);
    await alertAsync(messageOf(error));
  }
  await finish(blocks, host);
}

/** Merge each block (Merge & Center, Merge Across, Merge Cells). */
async function mergeBlocks(
  kind: MergeGestureKind,
  blocks: Block[],
  label: string,
  host: MergeGestureHost,
): Promise<void> {
  const options: MergeOptions = { across: kind === "mergeAcross", absorb: true, keepFirstValue: true };
  const mergeable = blocks.filter((b) => (kind === "mergeAcross" ? b.startCol !== b.endCol : !isSingleCell(b)));
  // Merge & Center on a single cell only centres it (Excel).
  const centreOnly = kind === "mergeCenter" ? blocks.filter(isSingleCell) : [];
  if (mergeable.length === 0 && centreOnly.length === 0) return;

  // ASK FIRST, CHANGE NOTHING. Every block is probed -- every gate runs, the
  // plan is counted -- before anything is written, so a refusal or a Cancel
  // leaves the workbook exactly as it was.
  let lossy = 0;
  for (const b of mergeable) {
    try {
      const plan = await mergeCells(b.startRow, b.startCol, b.endRow, b.endCol, undefined, {
        ...options,
        probe: true,
      });
      lossy += plan?.lossyRegions ?? 0;
    } catch (error) {
      await alertAsync(messageOf(error));
      return;
    }
  }
  if (lossy > 0) {
    const ok = await confirmAsync(MERGE_DISCARDS_VALUES, {
      kind: "warning",
      okLabel: "OK",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
  }

  let tx: OwnedUndoTransaction | null = null;
  let applied = false;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction(label), UNDO_CLOSES);
    const moved: MovedCell[] = [];
    for (const b of mergeable) {
      const result = await mergeCells(b.startRow, b.startCol, b.endRow, b.endCol, undefined, options);
      if (result?.success) {
        applied = true;
        moved.push(...(result.movedCells ?? []));
      }
    }
    // A moved value keeps its readers: formulas that pointed at it now point
    // at the merged cell (Excel re-points them the way a cut and paste does).
    for (const m of moved) {
      await relocateCellReferences(m.fromRow, m.fromCol, m.fromRow, m.fromCol, m.toRow, m.toCol);
    }
    if (kind === "mergeCenter") {
      for (const b of [...mergeable, ...centreOnly]) {
        await alignArea(b, "center");
        applied = true;
      }
    }
    await tx.commit();
  } catch (error) {
    // Only reachable if something changed between the probe and the write
    // (another window's edit, a script). What ran stays one undo step.
    await closeAfterFailure(tx, applied);
    await alertAsync(messageOf(error));
  }
  await finish(blocks, host);
}

/**
 * Close the transaction after a failure: COMMIT when something was already
 * written (so Ctrl+Z can take it back -- a cancel drops the undo record and
 * keeps the writes), CANCEL when nothing was.
 */
async function closeAfterFailure(tx: OwnedUndoTransaction | null, applied: boolean): Promise<void> {
  if (!tx) return;
  try {
    if (applied) await tx.commit();
    else await tx.cancel();
  } catch {
    // The close itself failed; nothing more can be done here.
  }
}

/** Repaint and announce, the way Clear All does. */
async function finish(blocks: Block[], host: MergeGestureHost): Promise<void> {
  try {
    await host.refresh();
  } catch (error) {
    console.error("[merge] refresh failed:", error);
  }
  // The MAIN block is the last one (selectionBlocks lists the Ctrl+click
  // ranges first): announce at its top-left, as Clear All does.
  const main = blocks[blocks.length - 1];
  if (main) {
    cellEvents.emit({ row: main.startRow, col: main.startCol, oldValue: undefined, newValue: "", formula: null });
  }
}
