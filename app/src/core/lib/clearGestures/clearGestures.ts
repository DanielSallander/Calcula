//! FILENAME: app/src/core/lib/clearGestures/clearGestures.ts
// PURPOSE: Excel's Clear menu as gestures over the selection: Clear All, Clear
//          Formats, Clear Contents, Clear Comments and Notes, Clear Hyperlinks
//          and Remove Hyperlinks.
// CONTEXT: These are the handlers behind the grid commands `clearAll`,
//          `clearFormatting`, `clearContents`, `clearComments`,
//          `clearHyperlinks` and `removeHyperlinks`, which Core's Spreadsheet
//          registers (CLAUDE.md rule 5's precedent for grid gestures, like
//          core/lib/merge). The Home tab's Clear menu, the Edit menu, the Delete
//          key, the right-click menu and object scripts all reach them through
//          the ONE grid-command door.
//
//          Before (2026-10-04): Clear Contents and Clear Formats sent a refusal
//          to the console, so the Delete key on a protected sheet looked dead
//          (Clear All already alerted); each handler cleared only the selection's
//          LAST block, so Delete after a Ctrl+click selection left the other
//          blocks alone; Clear Comments left notes in place.
//
// THE RULES (Excel, observed live in Microsoft 365 build 20326, 2026-10-04):
// - Every block of a Ctrl+click selection is cleared.
// - Clear Comments and Notes removes threaded comments AND notes.
// - Clear All also removes notes and hyperlinks.
// - Clear Hyperlinks removes the links and KEEPS every format.
// - Remove Hyperlinks, on each cell that HOLDS a link, removes the link AND
//   every format -- bold, fill, number format, alignment, borders: the cell is
//   back to the Normal style. A cell in the selection without a link keeps its
//   formatting; values stay. With no link in the selection Excel greys the
//   item, so the command changes nothing.
// - Each command is ONE undo step: one Undo restores everything it removed.
//   (The comment / note / hyperlink range clears record their own undo
//   entries since the rust-structure lane's change; the transaction below makes
//   them one step with the rest.)

import type { CellTargetRef, Selection } from "../../types";
import {
  beginUndoTransaction,
  cancelUndoTransaction,
  clearCommentsInRange,
  clearHyperlinksInRange,
  clearNotesInRange,
  clearRange,
  clearRangeWithOptions,
  commitUndoTransaction,
  getHyperlinksInRange,
} from "../tauri-api";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "../undoTransactionOwnership";
import { alertAsync } from "../dialogs";
import { cellEvents } from "../cellEvents";
import { selectionBlocks, type Block } from "../merge/mergeGeometry";

/** The six commands, named as their grid commands are. */
export type ClearGestureKind =
  | "clearContents"
  | "clearFormatting"
  | "clearComments"
  | "clearHyperlinks"
  | "clearAll"
  | "removeHyperlinks";

/** What a gesture needs from the grid that runs it. */
export interface ClearGestureHost {
  /** The selection the gesture acts on (the target's own coordinates with a target). */
  selection: Selection | null;
  /**
   * The OBJECT whose cells the gesture clears (a floating grid's, P3), or
   * absent for the active sheet. With a target every write names it, and only
   * what an object's cells can hold is cleared: contents and formats. Comments,
   * notes and hyperlinks have no door onto an object's cells (their doors keep
   * refusing there), so Clear Comments / Clear Hyperlinks / Remove Hyperlinks
   * change nothing, and Clear All clears contents and formats in ONE call --
   * never the active sheet's comments, notes or links at the same coordinates.
   */
  target?: CellTargetRef;
  /**
   * Re-read what the clear changed, once its writes have landed: the grid's
   * cells and, through `grid:refresh` (and `styles:refresh` when FORMATS
   * changed), every listener that shows the active cell's state -- the Home
   * ribbon's Bold / alignment / number format. Like MergeGestureHost.refresh.
   * Without it Clear Formats repainted the cell plain while the ribbon kept the
   * cleared formatting lit until the selection moved (review finding (b),
   * 2026-10-04).
   */
  refresh(changed: { formats: boolean }): Promise<void> | void;
}

/** What each command's ONE undo step is called in Edit > Undo. */
const STEP_LABELS: Record<ClearGestureKind, string> = {
  clearContents: "Clear Contents",
  clearFormatting: "Clear Formats",
  clearComments: "Clear Comments and Notes",
  clearHyperlinks: "Clear Hyperlinks",
  clearAll: "Clear All",
  removeHyperlinks: "Remove Hyperlinks",
};

/** The closes an owned transaction uses, read when the close runs. */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The cells of `block` that hold a hyperlink, on the active sheet -- read
 * through Core's own IPC wrapper (`getHyperlinksInRange`, the Hyperlinks
 * store's indicator query), like every other backend call here.
 */
async function linkedCellsIn(block: Block): Promise<Array<{ row: number; col: number }>> {
  const indicators = await getHyperlinksInRange(block.startRow, block.startCol, block.endRow, block.endCol);
  return (indicators ?? []).map(({ row, col }) => ({ row, col }));
}

/** One backend write of the gesture. */
type Write = () => Promise<unknown>;

/** Whether `kind` changes FORMATS (the style cache must re-read). */
function clearsFormats(kind: ClearGestureKind): boolean {
  return kind === "clearFormatting" || kind === "clearAll" || kind === "removeHyperlinks";
}

/**
 * The writes `kind` makes over `blocks`, in order: PHASE by phase, every
 * block's write of one phase before any block's write of the next.
 *
 * The first phase is the write the backend can REFUSE -- contents + formats
 * (Clear All), the linked cells' formats (Remove Hyperlinks), the comments
 * (Clear Comments and Notes) -- and each such call runs its gates (sheet
 * protection, a pivot / report region, a spill, a writeback claim) before it
 * changes anything. Block by block, Clear All over two areas wiped the FIRST
 * area whole -- contents, formats, comments, notes, links -- before the second
 * area's refusal (review finding (c), 2026-10-04). Phase by phase, a refused
 * area stops the gesture before ANY comment, note or link anywhere is removed.
 *
 * What this does NOT give is Excel's whole-selection refusal: the areas before
 * the refused one have had their first-phase write (for Clear All, their
 * contents and formats). Those are committed as the gesture's ONE undo step,
 * so one Ctrl+Z restores them (runClearGesture). Refusing the whole selection
 * before any write needs a backend command that gates several ranges in one
 * call -- the same multi-range clear that would make a scattered Delete one
 * call instead of one per area -- and there is none yet.
 */
async function writesFor(kind: ClearGestureKind, blocks: Block[], target?: CellTargetRef): Promise<Write[]> {
  if (target) return targetWritesFor(kind, blocks, target);
  const phases: Write[][] = [];
  const add = (phase: number, write: Write): void => {
    (phases[phase] ??= []).push(write);
  };
  for (const b of blocks) {
    const { startRow: r0, startCol: c0, endRow: r1, endCol: c1 } = b;
    switch (kind) {
      case "clearContents":
        add(0, () => clearRange(r0, c0, r1, c1));
        break;
      case "clearFormatting":
        add(0, () => clearRangeWithOptions(r0, c0, r1, c1, "formats"));
        break;
      case "clearComments":
        add(0, () => clearCommentsInRange(r0, c0, r1, c1));
        add(1, () => clearNotesInRange(r0, c0, r1, c1));
        break;
      case "clearHyperlinks":
        add(0, () => clearHyperlinksInRange(r0, c0, r1, c1));
        break;
      case "clearAll":
        add(0, () => clearRangeWithOptions(r0, c0, r1, c1, "all"));
        add(1, () => clearCommentsInRange(r0, c0, r1, c1));
        add(2, () => clearNotesInRange(r0, c0, r1, c1));
        add(3, () => clearHyperlinksInRange(r0, c0, r1, c1));
        break;
      case "removeHyperlinks": {
        const linked = await linkedCellsIn(b);
        if (linked.length === 0) break;
        // The FORMATS of each linked cell -- never of the block: a cell without
        // a link keeps its formatting. Then the links themselves.
        for (const { row, col } of linked) {
          add(0, () => clearRangeWithOptions(row, col, row, col, "formats"));
        }
        add(1, () => clearHyperlinksInRange(r0, c0, r1, c1));
        break;
      }
    }
  }
  // A block that added nothing (Remove Hyperlinks without a link) leaves no
  // hole: `add` only ever creates the phases some block used.
  return phases.flatMap((phase) => phase ?? []);
}

/**
 * The writes `kind` makes over an OBJECT's cells: one `clearRangeWithOptions`
 * per block, with the target (one undo step each; several are bracketed by the
 * runner). Only contents and formats exist there (see ClearGestureHost.target).
 */
function targetWritesFor(kind: ClearGestureKind, blocks: Block[], target: CellTargetRef): Write[] {
  const applyTo = kind === "clearContents" ? "contents" : kind === "clearFormatting" ? "formats" : kind === "clearAll" ? "all" : null;
  if (applyTo === null) return [];
  return blocks.map((b) => () =>
    clearRangeWithOptions(b.startRow, b.startCol, b.endRow, b.endCol, applyTo, undefined, { target }),
  );
}

/**
 * Run one of Excel's Clear commands over `host.selection`. Never throws:
 * every refusal reaches the user as an alert.
 */
export async function runClearGesture(kind: ClearGestureKind, host: ClearGestureHost): Promise<void> {
  const blocks = selectionBlocks(host.selection);
  if (blocks.length === 0) return;

  let writes: Write[];
  try {
    writes = await writesFor(kind, blocks, host.target);
  } catch (error) {
    console.error(`[clearGestures] ${kind}: reading the selection failed:`, error);
    await alertAsync(messageOf(error));
    return;
  }
  if (writes.length === 0) return;

  // ONE write is its own undo step (the backend command opens one, or joins a
  // script's batch). Several are bracketed into ONE step; a begin that JOINS
  // a script's open batch closes nothing (undoTransactionOwnership). Clear All
  // keeps its own step even for one block, as it always has.
  const bracket = writes.length > 1;
  let tx: OwnedUndoTransaction | null = null;
  let landed = 0;
  try {
    if (bracket) {
      tx = ownUndoTransaction(await beginUndoTransaction(STEP_LABELS[kind]), UNDO_CLOSES);
    }
    // One backend call per area per phase, in sequence: the backend has no
    // multi-range clear, so Delete over a scattered Go To Special result (up to
    // MAX_MATCH_AREAS = 10,000 areas) is that many clear calls, each with its
    // own dependents pass, inside this ONE undo step (review finding (d),
    // 2026-10-04; the count is pinned in the tests).
    for (const write of writes) {
      await write();
      landed++;
    }
    await tx?.commit();
  } catch (error) {
    console.error(`[clearGestures] ${kind} failed:`, error);
    // What LANDED is committed, never cancelled: a cancel drops the undo record
    // and keeps the writes, so the comments already removed would be gone
    // for good. With nothing landed the empty step is cancelled.
    if (landed > 0) {
      await tx?.commit().catch(() => {});
    } else {
      await tx?.cancel().catch(() => {});
    }
    await alertAsync(messageOf(error));
    if (landed === 0) return;
  }

  // One announcement for the gesture (the grid re-reads its cells). Clear
  // Contents and Clear All tell listeners it was a CLEAR, as they always have.
  // Not for a target: a cell event's (row, col) names an ACTIVE-sheet cell,
  // and an object's coordinates would alias the host's cell there. The
  // object's cells re-read through the refresh's "grid:refresh".
  const first = blocks[0];
  const source = kind === "clearContents" || kind === "clearAll" ? "clear" : undefined;
  if (!host.target) {
    cellEvents.emit(
      { row: first.startRow, col: first.startCol, oldValue: undefined, newValue: "", formula: null },
      source,
    );
  }

  // Then the grid, and everything that shows the active cell's state, re-read.
  try {
    await host.refresh({ formats: clearsFormats(kind) });
  } catch (error) {
    console.error(`[clearGestures] ${kind}: refresh failed:`, error);
  }
}
