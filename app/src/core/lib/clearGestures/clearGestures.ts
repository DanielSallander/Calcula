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
// - GROUPED SHEETS (tabs Ctrl+clicked together; observed live in Microsoft 365,
//   2026-10-29, BUG-0350): Delete, Clear Contents, Clear Formats and Clear All
//   clear the same range on EVERY sheet of the group, and ONE Undo restores
//   every sheet. ALL OR NOTHING: with one grouped sheet protected, Excel clears
//   nothing on ANY sheet (live, review G#1). Here the group's write comes FIRST,
//   as ONE call for every block (`clearRangeOnSheets`), which gates every
//   grouped sheet -- the active one included -- for every block (protection, a
//   pivot / report region, a spill, a writeback claim) before it writes any;
//   only then does the active sheet's own clear run, in the same one undo step.
//   The group counts only while the sheet on screen is one of it: Excel
//   ungroups when you reach another sheet (Name Box, Go To, a link), and a
//   group left behind must not be cleared off screen (review G#4). Clear
//   Comments and Notes, Clear Hyperlinks and Remove Hyperlinks stay on the
//   ACTIVE sheet: the comment, note and hyperlink stores have no sheet-
//   addressed clear (the off-sheet clear refuses hyperlinks outright), so Clear
//   All's comments, notes and links are removed on the active sheet only.
//
// THE ONE DOOR. Delete, the Home tab's Clear menu, the Edit menu, the
// right-click menu and scripts all run these through the grid command, so
// what the gesture does -- the group, the one-cell writeback edit below, the
// one undo step -- is decided HERE. The group replication used to live in
// useSpreadsheetSelection's own Delete handler, which the registry's Delete
// binding pre-empts in the capture phase: Delete with grouped sheets cleared
// the active sheet only (BUG-0350). Backspace is not one of these: as in Excel
// it opens an empty entry in the ACTIVE cell (useSpreadsheetSelection's
// handleDeleteContents, review G#7).

import type { CellTargetRef, Selection } from "../../types";
import {
  beginUndoTransaction,
  cancelUndoTransaction,
  clearCommentsInRange,
  clearHyperlinksInRange,
  clearNotesInRange,
  clearRangeOnSheets,
  clearRangeWithOptions,
  commitUndoTransaction,
  getHyperlinksInRange,
} from "../tauri-api";
import { ownUndoTransaction, type OwnedUndoTransaction, type UndoTransactionCloses } from "../undoTransactionOwnership";
import { alertAsync } from "../dialogs";
import { cellEvents } from "../cellEvents";
import { selectionBlocks, type Block } from "../merge/mergeGeometry";
import { checkRangeGuards } from "../editGuards";
import { commitGridCellText } from "../selectionOwner";
import { getSelectedSheetIndices, isSheetGroupingActive } from "../../state/sheetGrouping";
import { getGridStateSnapshot } from "../../state/GridContext";

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

/** The commands a sheet group replicates (see THE RULES: Excel, live). */
const REPLICATED_ACROSS_A_GROUP: ReadonlySet<ClearGestureKind> = new Set<ClearGestureKind>([
  "clearContents",
  "clearFormatting",
  "clearAll",
]);

/** The sheet group a clear reaches: the sheet on screen and the OTHER grouped sheets. */
interface ClearGroup {
  active: number;
  others: number[];
}

/**
 * The sheet group `kind` clears -- null without a group, for a command the
 * group does not replicate, when the sheet on screen is not known (nothing
 * would tell the active sheet from the others), or when the sheet on screen is
 * NOT one of the group (review G#4): the group was left behind by a switch
 * that is not a tab click (the Name Box, Go To, a link, the command line), and
 * Excel ungroups on such a switch, so clearing the old group's sheets off
 * screen would be a silent edit Excel never makes.
 */
function groupedSheetsFor(kind: ClearGestureKind): ClearGroup | null {
  if (!REPLICATED_ACROSS_A_GROUP.has(kind) || !isSheetGroupingActive()) return null;
  const active = getGridStateSnapshot()?.sheetContext.activeSheetIndex;
  if (active === undefined) return null;
  const grouped = getSelectedSheetIndices();
  if (!grouped.includes(active)) return null;
  const others = grouped.filter((index) => index !== active);
  return others.length > 0 ? { active, others } : null;
}

/** The backend's name for what a replicated `kind` clears. */
function groupApplyTo(kind: ClearGestureKind): "contents" | "formats" | "all" {
  return kind === "clearContents" ? "contents" : kind === "clearFormatting" ? "formats" : "all";
}

/**
 * ONE CELL THAT TAKES ONE EDIT AT A TIME (Clear Contents on the active sheet).
 * A range guard can admit a single-cell EDIT and refuse a bulk write -- a
 * writeback cell collects one answer at a time, and its owner records it in
 * its commit guard. A bulk clear there is refused by the backend; Delete on
 * that one cell is the user clearing their answer, so it is ENTERED as an
 * empty edit and the owner's commit guard sees it -- what F2, Backspace and
 * Enter always did. True when the edit was entered; false leaves the clear to
 * run (no committer, or the edit was refused, which says why itself), and its
 * refusal names the remedy.
 */
async function enteredAsOneCellEdit(blocks: Block[]): Promise<boolean> {
  if (blocks.length !== 1) return false;
  const { startRow: r0, startCol: c0, endRow: r1, endCol: c1 } = blocks[0];
  if (r0 !== r1 || c0 !== c1) return false;
  if (!checkRangeGuards(r0, c0, r1, c1, "other")?.blocked) return false;
  if (checkRangeGuards(r0, c0, r1, c1, "edit")?.blocked) return false;
  return commitGridCellText("");
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
 * Each phase is ONE call for every block (BUG-0394): the cell clear sends the
 * other blocks as `moreAreas`, and the backend gates EVERY block before it
 * writes any (BUG-0395) -- Excel's whole-selection refusal [LIVE, 2026-11-04:
 * A1 unlocked and C1 locked on a protected sheet, both selected, Delete
 * refuses and A1 keeps its value]. Remove Hyperlinks reads each block's links
 * first, then makes ONE call over the blocks that hold any (BUG-0736).
 *
 * `group` is the sheet group (groupedSheetsFor). Its write is the VERY FIRST
 * one: ONE `clearRangeOnSheets` over every block, listing the active sheet
 * too, so the backend gates every grouped sheet -- the active one included --
 * for every block before it writes anything (review G#1: Excel clears nothing
 * anywhere when one grouped sheet refuses; the active sheet's clear used to run
 * first and stay). It writes every other grouped sheet in one lock phase with
 * one recalculation (review G#9: it was one call, and two whole-sheet passes,
 * per block). The active sheet's own per-block writes follow it in the same
 * phase, and a refusal anywhere stops the gesture before any comment, note or
 * link is removed.
 */
async function writesFor(
  kind: ClearGestureKind,
  blocks: Block[],
  target: CellTargetRef | undefined,
  group: ClearGroup | null,
): Promise<Write[]> {
  if (target) return targetWritesFor(kind, blocks, target);
  const phases: Write[][] = [];
  const add = (phase: number, write: Write): void => {
    (phases[phase] ??= []).push(write);
  };
  if (group && blocks.length > 0) {
    const [first, ...rest] = blocks;
    const sheets = [group.active, ...group.others];
    const moreAreas = rest.map(({ startRow, startCol, endRow, endCol }) => ({ startRow, startCol, endRow, endCol }));
    const applyTo = groupApplyTo(kind);
    add(0, () =>
      clearRangeOnSheets(sheets, first.startRow, first.startCol, first.endRow, first.endCol, { applyTo, moreAreas }),
    );
  }
  // EVERY BLOCK IN ONE CALL PER PHASE (BUG-0394 / BUG-0395). The cell clear
  // takes the other blocks as `moreAreas`: the backend gates every block
  // before it writes any (one refusing block clears none -- Excel [LIVE],
  // 2026-11-04) and runs ONE dependents cascade; the comment, note and
  // hyperlink clears take them the same way. Delete over a Go To Special
  // result (up to MAX_MATCH_AREAS = 10,000 areas) was that many calls, each
  // with its own cascade. Delete is Clear CONTENTS, as in Excel: the cells
  // keep their formats (it went through `clearRange`, which removed them).
  if (blocks.length > 0 && kind !== "removeHyperlinks") {
    const [first, ...rest] = blocks;
    const { startRow: r0, startCol: c0, endRow: r1, endCol: c1 } = first;
    const more = rest.map(({ startRow, startCol, endRow, endCol }) => ({ startRow, startCol, endRow, endCol }));
    // One block keeps the one-block call it always made.
    const cells = (applyTo: "contents" | "formats" | "all"): Write => () =>
      more.length > 0
        ? clearRangeWithOptions(r0, c0, r1, c1, applyTo, undefined, { moreAreas: more })
        : clearRangeWithOptions(r0, c0, r1, c1, applyTo);
    const annotations =
      (clear: (r0: number, c0: number, r1: number, c1: number, moreAreas?: typeof more) => Promise<number>): Write =>
      () =>
        more.length > 0 ? clear(r0, c0, r1, c1, more) : clear(r0, c0, r1, c1);
    switch (kind) {
      case "clearContents":
        add(0, cells("contents"));
        break;
      case "clearFormatting":
        add(0, cells("formats"));
        break;
      case "clearComments":
        add(0, annotations(clearCommentsInRange));
        add(1, annotations(clearNotesInRange));
        break;
      case "clearHyperlinks":
        add(0, annotations(clearHyperlinksInRange));
        break;
      case "clearAll":
        add(0, cells("all"));
        add(1, annotations(clearCommentsInRange));
        add(2, annotations(clearNotesInRange));
        add(3, annotations(clearHyperlinksInRange));
        break;
    }
  }
  if (kind === "removeHyperlinks") {
    // ONE backend call over every block that holds a link (BUG-0736): the
    // command's own "removeHyperlinks" clears, on each LINKED cell only, the
    // link and the cell's format (a cell without a link keeps its formatting),
    // gates every area before it writes any, and records ONE undo step. It was
    // one format clear per linked cell plus one link clear per block.
    const holding: Block[] = [];
    for (const b of blocks) {
      if ((await linkedCellsIn(b)).length > 0) holding.push(b);
    }
    if (holding.length > 0) {
      const [first, ...rest] = holding;
      const more = rest.map(({ startRow, startCol, endRow, endCol }) => ({ startRow, startCol, endRow, endCol }));
      add(0, () =>
        more.length > 0
          ? clearRangeWithOptions(first.startRow, first.startCol, first.endRow, first.endCol, "removeHyperlinks", undefined, { moreAreas: more })
          : clearRangeWithOptions(first.startRow, first.startCol, first.endRow, first.endCol, "removeHyperlinks"),
      );
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

  // The active sheet's own cells only: an object's cells have no range guards
  // of the sheet's, and no sheet group.
  if (!host.target && kind === "clearContents" && (await enteredAsOneCellEdit(blocks))) return;
  const group = host.target ? null : groupedSheetsFor(kind);

  let writes: Write[];
  try {
    writes = await writesFor(kind, blocks, host.target, group);
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
    // One backend call per PHASE for every area (BUG-0394; writesFor): Delete
    // over a scattered Go To Special result (up to MAX_MATCH_AREAS = 10,000
    // areas) is ONE clear call with ONE dependents pass, where it was one call
    // and one pass per area (the count is pinned in the tests). The sheet
    // group's other sheets are ONE call for every area too.
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
