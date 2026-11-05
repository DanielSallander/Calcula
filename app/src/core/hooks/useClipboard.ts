//! FILENAME: app/src/core/hooks/useClipboard.ts
// PURPOSE: Custom hook for clipboard operations (cut, copy, paste).
// CONTEXT: Handles reading/writing to system clipboard and cell data operations.
// Updated: Added clearClipboardState for ESC key handling.
// Updated: Selection now moves to pasted range after paste.
// Updated: Copy source remains active after paste (only cut clears clipboard).

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { writeText as tauriWriteText, readText as tauriReadText, writeHtml as tauriWriteHtml } from "@tauri-apps/plugin-clipboard-manager";
import { useGridContext, getGridStateSnapshot } from "../state/GridContext";
import { AppEvents } from "../lib/events";
import {
  AppEvents as ApiAppEvents,
  type CellValueChange,
  type CellValuesChangedPayload,
  type MutationRefreshPayload,
} from "../../api/events";
import {
  getCell,
  getViewportCells,
  getAllComments,
  getCommentsForSheet,
  getAllDataValidations,
  updateCell,
  updateCellsBatch,
  clearCell,
  clearRange,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
  getCellsInRows,
  getCellsInCols,
  hasContentInRange,
  setCellStyle,
  shiftFormulasBatch,
  getCollectionTexts,
  getComment,
  getDataValidation,
  relocateCellReferences,
  clearRangeWithOptions,
  getSheets,
  getWatchCells,
  getRangeCellsTyped,
  beginUndoSavepoint,
  rollBackToUndoSavepoint,
  insertCellsRange,
  insertRows,
  insertColumns,
  getMergedRegions,
} from "../lib/tauri-api";
import { PASTE_ONCE, pasteMayTile, pasteTiles, type PasteTiles } from "../lib/pasteTiling";
import { copiedCell, isDataTableFormula } from "../lib/dataTableCopy";
import { gridCommands } from "../lib/gridCommands";
import type { CellUpdateInput, FormulaShiftInput, MovedFrom, PasteSource, UndoSavepoint } from "../lib/tauri-api";
import {
  ownUndoTransaction,
  type OwnedUndoTransaction,
  type UndoTransactionCloses,
} from "../lib/undoTransactionOwnership";
import { cellEvents } from "../lib/cellEvents";
import { setClipboard, clearClipboard, setSelection } from "../state/gridActions";
import type {
  Selection,
  CellData,
  CellTargetRef,
  ClipboardMode,
  Comment,
  DataValidation,
  ValidationRange,
  TypedCellData,
} from "../types";
import { BEYOND_EVERY_SHEET, renumberedSheetIndex } from "../state/sheetRenumbering";
import type { StructuralLineEdit } from "../../api/structuralFollow";
import type { StructuralEditElsewherePayload, StructuralUndoPayload } from "../../api/events";
import { announceCellsMoved, announceRolledBackRestore } from "../lib/cellsMoved";
import type { GridCommandContext } from "../lib/gridCommands";
import type { CellTarget } from "../lib/selectionOwner";
import { getCellTargetCells, selectTargetCells } from "../../api/cellTarget";
import { checkRangeGuards } from "../lib/editGuards";
import {
  captureClipboardCells,
  copyableSourceRows,
  pasteRowDeltas,
  MAX_CLIPBOARD_CELLS,
} from "../lib/clipboardVisibility";
import {
  pastedConstantInput,
  readClipboardValues,
  readStoredValues,
  type ClipboardCellValue,
} from "../lib/clipboardValues";
// confirmAsync, never the plugin's raw `ask` (lint-banned outside
// lib/dialogs.ts): `ask` THROWS when its dialog cannot be shown, and each
// "replace the destination?" guard below then rejected unobserved instead of
// answering. confirmAsync resolves false instead -- no answer, no overwrite.
import { alertAsync, confirmAsync } from "../lib/dialogs";

/**
 * Internal clipboard data structure.
 * We store both the raw text and structured cell data.
 */
export interface ClipboardData {
  /**
   * Source selection when copy/cut was performed.
   *
   * This is the selection the USER made — it is NOT a promise about the shape
   * of `cells`. A copy that spanned filter-hidden rows collapses those rows
   * away, so the matrix can be shorter than the selection. Map matrix rows
   * back to the sheet with `sourceRows`, never with `sourceSelection.startRow + r`.
   */
  sourceSelection: Selection;
  /** Cell data matrix [row][col]; column c is sourceSelection's min col + c */
  cells: (CellData | null)[][];
  /**
   * Absolute sheet row each matrix row came from, one entry per row of `cells`.
   *
   * Equal to minRow, minRow+1, ... for an ordinary capture; for a COPY over a
   * filtered range it skips the filter-hidden rows (Excel copies visible cells
   * only and slides them together). Anything that shifts relative references
   * or re-reads the source by coordinate MUST consult this.
   */
  sourceRows: number[];
  /** Whether this was a cut operation (cells should be cleared on paste) */
  isCut: boolean;
  /**
   * The sheet the cells were copied FROM: its index and its name as they were
   * at the copy.
   *
   * Paste Link needs it: a link pasted on ANOTHER sheet must name the source
   * sheet (`=Sheet1!$A$1`, Excel), and without it the link was written as
   * `=$A$1` and pointed at the same addresses on the destination sheet
   * (clipboard survey defect 1). The NAME is kept as well as the index because
   * that is what a formula spells. Both go stale -- a rename changes the name,
   * a sheet inserted, moved or deleted the index -- so a paste that needs the
   * source sheet finds it NOW by `sourceSheetId` and falls back to these only
   * without one (BUG-0348: Paste Link after a rename spelled the old name).
   */
  sourceSheetIndex: number;
  sourceSheetName: string;
  /**
   * The source sheet's STABLE id (`SheetInfo.sheetId`, read from the sheet
   * context at the copy): no rename or renumbering changes it, so Paste Link
   * spells the sheet's name as it is at the PASTE -- Excel keeps copy mode
   * across a rename of the source sheet and links to the new name (measured
   * live through COM, 2026-10-29). A CUT pasted on another sheet finds its
   * source here too, and clears it on that sheet (`cutSourceSheetNow`); a cut
   * whose sheet has been deleted pastes nothing. Absent for an object source
   * and when the context carried no id.
   */
  sourceSheetId?: string;
  /**
   * The OBJECT the cells were copied from (a floating grid's, P3), or absent
   * for a sheet. With it, `sourceSelection` / `sourceRows` are the object's
   * own (backing) coordinates, `sourceSheetName` is the object's name ("Float1",
   * which a formula spells as a sheet: Paste Link writes `=Float1!$A$1`), and
   * `sourceSheetIndex` is -1 -- never a sheet, so nothing that compares it with
   * the active sheet takes the object's coordinates for the sheet's.
   */
  sourceTarget?: CellTargetRef;
  /**
   * The copied cells' STORED values, aligned with `cells` ([row][col], null =
   * an empty cell), read TYPED at the copy: the number 1.23456, never the
   * "1.23" it shows under 0.00; a formula cell's RESULT. A paste writes a
   * constant from this (`pastedConstantInput`, @api/lib) -- exactly, and
   * invariant -- instead of re-typing the display text, which pasted every
   * number only as exactly as its format showed it (and "5,50 kr" as text).
   * Absent when the copy could not read its cells typed: the paste then
   * falls back to the display text.
   */
  values?: (ClipboardCellValue | null)[][];
  /** Plain text representation for system clipboard */
  text: string;
  /** Map of "row,col" (relative) to JSON text for collection cells (List/Dict) */
  collectionTexts?: Map<string, string>;
  /** Map of "row,col" (relative) to Comment for cells that have comments */
  comments?: Map<string, Comment>;
  /** Map of "row,col" (relative) to DataValidation for cells that have validation */
  validations?: Map<string, DataValidation>;
}

/**
 * Return type for the useClipboard hook.
 */
export interface UseClipboardReturn {
  /**
   * Cut selected cells to clipboard. The grid-command door hands `ctx.target`
   * (an object's cells, P3); without one, Core's selection.
   */
  cut: (args?: unknown, ctx?: GridCommandContext) => Promise<void>;
  /** Copy selected cells to clipboard (see `cut` for `ctx`). */
  copy: (args?: unknown, ctx?: GridCommandContext) => Promise<void>;
  /** Paste clipboard contents to current selection (see `cut` for `ctx`). */
  paste: (args?: unknown, ctx?: GridCommandContext) => Promise<void>;
  /** Check if clipboard has content */
  hasClipboardData: () => boolean;
  /** Get current clipboard mode */
  clipboardMode: ClipboardMode;
  /** Get clipboard selection (for rendering) */
  clipboardSelection: Selection | null;
  /** Clear clipboard state (for ESC key) */
  clearClipboardState: () => void;
  /** Move cells from source selection to target position */
  moveCells: (source: Selection, targetRow: number, targetCol: number) => Promise<void>;
  /** Reorder rows (structural move) */
  moveRows: (sourceStartRow: number, sourceEndRow: number, targetRow: number) => Promise<void>;
  /** Reorder columns (structural move) */
  moveColumns: (sourceStartCol: number, sourceEndCol: number, targetCol: number) => Promise<void>;
  /** Copy cells from source selection to target position (Ctrl+Drag, source stays intact) */
  copyCellsDrag: (source: Selection, targetRow: number, targetCol: number) => Promise<void>;
  /** Copy rows to target position (Ctrl+Drag, source stays intact) */
  copyRowsDrag: (sourceStartRow: number, sourceEndRow: number, targetRow: number) => Promise<void>;
  /** Copy columns to target position (Ctrl+Drag, source stays intact) */
  copyColumnsDrag: (sourceStartCol: number, sourceEndCol: number, targetCol: number) => Promise<void>;
}

/**
 * The closes every gesture here makes, bound to the begin's answer by
 * ownUndoTransaction: a gesture closes ONLY the undo transaction its own begin
 * OPENED. Inside a script's open batch (or a command-line run) the begin JOINS,
 * the gesture's writes become part of that holder's step, and the holder
 * closes it -- a paste that committed or cancelled unconditionally ended the
 * script's batch halfway, or dropped its undo record (wave E, Y7).
 */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

// Module-level clipboard storage (persists across hook instances)
let internalClipboard: ClipboardData | null = null;

/**
 * Get the current internal clipboard data.
 * Used by Paste Special to access structured clipboard content.
 */
export function getInternalClipboard(): ClipboardData | null {
  return internalClipboard;
}

/**
 * Store a new Copy / Cut. A clipboard of our own replaces whatever a cut that
 * ENDED left behind (`endedCutText`).
 */
function rememberClipboard(data: ClipboardData): void {
  internalClipboard = data;
  copyGeneration += 1;
  forgetSnapshotState();
  endedCutText = null;
  announceCutModeChange();
}

// ============================================================================
// CLIPBOARD MODE: how long a Copy or a Cut stays pasteable
// ============================================================================
//
// A Cut is a pending MOVE and a Copy a pending COPY of the cells their
// snapshot holds (`ClipboardData.cells`). Both stay pasteable for exactly as
// long as Excel's CutCopyMode does -- the marching ants. Excel 16 [LIVE,
// 2026-10-30, fresh instances, COM, keystrokes posted to the grid window and
// SendKeys / real clicks on a visible one; clipgroup/probe-*.ps1 and
// clipexcel/probe-*.ps1 in the fix programme's scratchpad] ENDS it -- the ants
// go, the Windows clipboard is EMPTIED, the Paste button greys out and a Paste
// pastes nothing -- for a Copy and a Cut alike, on:
//   - Esc;
//   - STARTING an edit in any cell -- a typed character, F2, even one then
//     abandoned with Esc;
//   - Delete / Clear Contents, Fill Down, a format change (the ribbon's Bold),
//     inserting or deleting rows or columns from the ribbon;
//   - a Sort (the ribbon's, an AutoFilter's), Remove Duplicates and Text to
//     Columns, from the ribbon or from COM alike, on any range [LIVE
//     2026-10-30, clip3/probe-*.ps1];
//   - Delete Cells and a deleted row or column from ANY route -- the dialog,
//     COM, another sheet, a band beside the copied block [LIVE 2026-10-30];
//   - deleting, moving or copying ANY sheet (a third sheet's too);
//   - Calculate Now (F9, Application.Calculate) and Calculate Sheet
//     (Shift+F9, Worksheet.Calculate) [LIVE 2026-10-30, rev11B/probe.ps1,
//     clip5/probe-endings.ps1; Range.Calculate and CalculateFull keep it; a
//     change of the calculation mode either way ends it too, not modelled];
//   - turning an AutoFilter on, applying or clearing its criteria (a column's
//     or all of them) -- reapplying it and removing it keep the mode;
//     Group / Ungroup of rows or columns and Clear Outline -- showing an
//     outline level keeps it; Merge and Unmerge [LIVE 2026-10-30, same probes];
//   - for a Cut, its own paste (a second Paste pastes nothing).
// It KEEPS it -- for both -- across a selection move, a sheet switch, adding,
// RENAMING or hiding a sheet, an Undo (Ctrl+Z, a structural one included), and
// a write that is not an edit (a COM / script value), even ONTO the copied or
// cut cells. A Paste then pastes what the source holds AT THE PASTE: a COM
// write of 77 into the cut A1, then Paste -> 77 moves; a copy of =Sheet2!B1*2,
// Sheet2 renamed Inputs, Paste -> =Inputs!E1*2.
//
// The endings are announcements every route already makes, so no route has to
// remember a call (`listenForClipboardModeEndings`): EDIT_STARTED (the one emit
// site of all three Core edit opens, useEditing.ts), CELL_VALUES_CHANGED from a
// clear or a fill, STYLE_ENTRIES_UPDATED (every formatting door announces
// through `announceStyleEntries`), the row/column inserts and deletes on the
// sheet on screen, SHEET_DELETED, a sheet copy (SHEET_ADDED from a copy), a
// sheet move (`sheet:reorder` naming two real indices -- the tab strip and the
// script door both send it), and a document replacement. Esc is
// `clearClipboardState`. A Sort, a Remove Duplicates and a Text to Columns
// announce DATA_COMMAND_APPLIED from their one write path (@api/backend's
// `sortRange` and `removeDuplicates`, Text to Columns' `writeSplitAsOneStep`),
// and so do the AutoFilter criteria doors (@api/backend), Merge / Unmerge and
// Calculate Now / Calculate Sheet (the core/lib/tauri-api wrappers every route
// calls); Group / Ungroup / Clear Outline are told by OUTLINE_CHANGED's
// command. A calculation-mode change (`setCalculationMode`) and a refresh of
// the data underneath the grid (@api/dataAftermath, Excel's Data > Refresh
// All) announce DATA_COMMAND_APPLIED too [LIVE]. A delete among
// STRUCTURAL_UNDO's or STRUCTURAL_EDIT_ELSEWHERE's edits ends the mode (below).
//
// A COPIED FORMULA'S VALUE FOLLOWS ITS RECALCULATION. Where Excel keeps the
// mode across a write that recalculates a copied formula (a script, a scheduled
// job), a Paste Values pastes the NEW value and Notepad receives it
// [LIVE, rev11B/probe2.ps1: copy B1 =A1*2 showing 10, a COM write of 7 into A1,
// PasteSpecial values -> 14]. So a change announced on a copied cell marks the
// snapshot stale whether its formula changed, only its value did, or even its
// shown text stayed the same (a number format can hide the new value), see
// `changeLandsOnCut`.
//
// WHERE EXCEL KEEPS THE MODE, THE PASTE MUST NOT USE A STALE SNAPSHOT (BUG-0616
// item 5, the cut-mode endings round 8 chose against Excel). A rename leaves the
// snapshot's formula TEXT spelling the old name (Cut A2 =Sheet2!B1*2, rename
// Sheet2 to Inputs, Paste wrote =Sheet2!B1*2, a #REF!), and an undo or a script
// write onto the source leaves the snapshot holding a value the source no
// longer has -- moved, it would overwrite the user's current value. Round 8
// ENDED cut mode on all of those. Now each of them marks the snapshot STALE
// (`markSnapshotStale`), and the snapshot is READ AGAIN from its source, by the
// source sheet's stable id, through the sheet-addressed reads
// (`refreshClipboardSnapshot`): the formulas then spell the names the backend
// rewrote, and the values are the source's own -- and so are the text the
// system clipboard holds, the comments, the validations and the collection
// texts. Every paste door waits for the read (`settledSnapshot`; Paste Special
// through `settledInternalClipboard`). Size never decides whether a snapshot is
// read again: the read is sparse and banded, and a snapshot of more than
// SNAPSHOT_EAGER_REREAD_MAX_CELLS cells (a whole column) is read when a paste
// asks rather than after every undo. A snapshot whose read FAILED is never
// pasted: the paste is refused, a copy's as well as a cut's, and the mode ends.
// Plain Paste, Cut + Paste and the drag moves and copies go one step further
// (BUG-0657): each write names its SOURCE cell (`pasteSourceOf`,
// `CellUpdateInput.source`) and the backend writes what that cell holds AT
// THE WRITE, so a writer that never stops (an animation, a fast scheduled job)
// cannot outrun the read; the snapshot then answers only for the format and
// the fallback `value`.
//
// STRUCTURAL CHANGES, measured on live Excel 16 (2026-10-30, a fresh unsaved
// workbook, a sentinel at the old address):
//   - An Undo or Redo of a row insert, a row delete or an Insert Cells KEEPS
//     both modes and does NOT move the source: the Paste takes what stands at
//     the copied ADDRESS now (copy A7, undo the insert that put v6 there: the
//     Paste pastes the sentinel s7 that came back to A7, and a cut MOVES it).
//     So STRUCTURAL_UNDO from an undo or redo marks the snapshot stale and it is
//     read again at the same address (`markSnapshotStale`).
//   - A ribbon row insert ends both modes (the ROWS_ family, above).
//   - A gesture TAKEN BACK to its savepoint (STRUCTURAL_UNDO, `source:
//     "rollback"`: Insert Copied Cells whose paste did not land) never
//     happened: a copy's source that followed its insert follows the inverse
//     deltas back, and a delta in it ends nothing.
//   - A DELETE -- Delete Cells (STRUCTURAL_UNDO, `source: "edit"`) or a
//     script's row, column or cell delete on any sheet -- ends a copy as well
//     as a cut [LIVE: COM Range.Delete xlShiftUp above, inside, below, beside
//     the copied block and on another sheet, Rows(2).Delete: CutCopyMode 0].
//   - An Insert Cells band on the sheet on screen (STRUCTURAL_UNDO,
//     `source: "edit"`) and a script's insert on any sheet
//     (STRUCTURAL_EDIT_ELSEWHERE) END a cut but KEEP a copy, whose source
//     FOLLOWS the shift: Insert Cells A2 shift down with A6 copied, the Paste
//     pastes A6's value from A7; a COM insert on the copy's sheet while another
//     sheet is on screen, the same. `followCopySource` shifts the snapshot's
//     address (and its marching ants) and reads it again there. An insert
//     that cuts INTO the copied block (inside it, or a band that covers part
//     of it) leaves the copy pasting the snapshot it has
//     (`snapshotPositionsLost`: never read again by address) -- never the
//     cells that slid into its old address.
//   - In Excel's UI an Insert with a copy pending IS Insert Copied Cells (see
//     INSERT COPIED CELLS below): the room it makes moves the copy's source as
//     above, and the copied cells are pasted into it [LIVE round 12: F6
//     copied, Insert Copied Cells at F2 shift down -> a later Paste pastes f6
//     from F7]. A script's own insertCellsRange / insertRows still inserts
//     blank cells (Excel's COM Range.Insert inserts the copy; not modelled).

/**
 * Who re-renders when the clipboard mode starts or ends: each mounted
 * `useClipboard` (its `useSyncExternalStore`), so what its host derives from
 * {@link isClipboardModeLive} at render is never a render behind.
 */
const cutModeSubscribers = new Set<() => void>();

/** Tell the subscribers that the clipboard mode may have started or ended. */
function announceCutModeChange(): void {
  for (const subscriber of [...cutModeSubscribers]) subscriber();
}

/** The `subscribe` of {@link isClipboardModeLive} as an external store. */
function subscribeToCutMode(onChange: () => void): () => void {
  cutModeSubscribers.add(onChange);
  return () => {
    cutModeSubscribers.delete(onChange);
  };
}

/** Whether a Cut is pending: Excel's cut mode, a Cut's marching ants. */
export function isCutModeLive(): boolean {
  return internalClipboard?.isCut === true;
}

/**
 * Whether a Copy OR a Cut is pending -- Excel's CutCopyMode, whatever sheet or
 * floating grid it came from (see CLIPBOARD MODE): what Esc ends.
 */
export function isClipboardModeLive(): boolean {
  return internalClipboard !== null;
}

/**
 * The text a Copy or Cut whose mode ENDED put on the system clipboard, for as
 * long as it may still be there. Ending the mode empties the clipboard
 * (`emptyClipboardOfEndedCut`), but that can fail -- another process holding
 * the clipboard open -- and a Paste must then still paste nothing, never the
 * ended clipboard's text as a copy. Cleared by the next Copy / Cut and by a
 * successful emptying.
 */
let endedCutText: string | null = null;

/** The mounted clipboard hooks' "take the marching ants down" (useClipboard). */
const cutEndedListeners = new Set<() => void>();

/** Clipboard text with Windows line endings normalised (Windows hands `\r\n` back). */
function normalizedClipboardText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Whether `systemText` is what a Copy or Cut whose mode ended left on the clipboard. */
function isEndedCutText(systemText: string | null | undefined): boolean {
  return endedCutText !== null && !!systemText && normalizedClipboardText(systemText) === endedCutText;
}

/** End the mode of `clip`, the clipboard that is pending (see CLIPBOARD MODE). */
function endModeOf(clip: ClipboardData): void {
  internalClipboard = null;
  forgetSnapshotState();
  endedCutText = normalizedClipboardText(clip.text);
  announceCutModeChange();
  for (const listener of [...cutEndedListeners]) listener();
  void emptyClipboardOfEndedCut(endedCutText);
}

/**
 * END cut mode, as Excel does (see CLIPBOARD MODE): the pending move is dropped
 * -- the next Paste pastes nothing -- the marching ants go, and the system
 * clipboard is emptied if it still holds what the cut put there. Returns whether
 * a cut was pending; a COPY is left alone (the endings only a cut has: its own
 * paste, a refused move, a structural change it cannot follow).
 */
export function endCutMode(): boolean {
  const clip = internalClipboard;
  if (!clip || !clip.isCut) return false;
  endModeOf(clip);
  return true;
}

/**
 * END the clipboard mode -- a Copy's as well as a Cut's -- as Excel does on
 * Esc, an edit, a clear, a fill, a format change, a row or column insert or
 * delete and a sheet deleted, moved or copied (see CLIPBOARD MODE): the next
 * Paste pastes nothing, the ants go, the system clipboard is emptied of what
 * the copy or cut put there. Returns whether anything was pending.
 */
export function endClipboardMode(): boolean {
  const clip = internalClipboard;
  if (!clip) return false;
  endModeOf(clip);
  return true;
}

/**
 * Empty the system clipboard of the copy or cut whose mode ended (Excel empties
 * it [LIVE]) -- only while it still holds that text and nothing newer of ours
 * exists: another program's newer copy is not ours to wipe.
 */
async function emptyClipboardOfEndedCut(ended: string): Promise<void> {
  try {
    const now = await tauriReadText();
    if (internalClipboard !== null || endedCutText !== ended) return;
    if (now && normalizedClipboardText(now) !== ended) {
      endedCutText = null;
      return;
    }
    await tauriWriteText("");
    if (endedCutText === ended) endedCutText = null;
  } catch (err) {
    console.warn("[Clipboard] The clipboard could not be emptied of the copy or cut that ended; a Paste still pastes nothing:", err);
  }
}

// ----------------------------------------------------------------------------
// A STALE SNAPSHOT, READ AGAIN (see CLIPBOARD MODE)
// ----------------------------------------------------------------------------

/**
 * The typed read's own ceiling per call (`MAX_TYPED_RANGE_CELLS`): a re-read
 * asks for its rows in bands of at most this many cells. Size never decides
 * WHETHER a snapshot is read again -- a whole-column copy is read again like a
 * single cell's (BUG-0616 follow-up: above this a copy pasted its stale
 * snapshot silently and a cut was refused) -- only WHEN (see below).
 */
export const SNAPSHOT_REREAD_BAND_CELLS = 100_000;

/**
 * A snapshot of more cells than this is read again LAZILY -- when a paste asks
 * for it (`settledSnapshot`) -- rather than in the background after every
 * undo, rename or write: a whole-column copy costs a read as long as the copy's
 * own, and an Undo the user presses ten times should not pay for ten of them.
 */
export const SNAPSHOT_EAGER_REREAD_MAX_CELLS = 100_000;

/** Bumped each time something may have changed what the pending clipboard's source holds. */
let staleGeneration = 0;
/** The `staleGeneration` the pending clipboard's snapshot was last read at. */
let freshGeneration = 0;
/**
 * The source may have MOVED under the snapshot (a structural change a copy
 * keeps its mode across): it is never read again by address.
 */
let snapshotPositionsLost = false;
/** The read under way, if any (one at a time). */
let snapshotRefresh: Promise<void> | null = null;
/**
 * The last read of the pending clipboard's source FAILED (and none has
 * succeeded since): what makes a stale snapshot UNREADABLE. Staleness alone is
 * not failure -- a mark that lands while a paste awaits is read again first
 * (`settledForPaste`), never refused as "could not be read".
 */
let snapshotReadFailed = false;
/**
 * Bumped by every new Copy / Cut (`rememberClipboard`): tells a re-read whose
 * clipboard was merely FOLLOWED or refreshed meanwhile (the same copy) from one
 * a newer copy replaced.
 */
let copyGeneration = 0;

/** A new Copy / Cut, or none: its snapshot is fresh. */
function forgetSnapshotState(): void {
  staleGeneration = 0;
  freshGeneration = 0;
  snapshotPositionsLost = false;
  snapshotReadFailed = false;
}

/** Whether the pending clipboard's snapshot may not be what its source holds now. */
function snapshotIsStale(): boolean {
  return staleGeneration !== freshGeneration;
}

/** How many source cells the pending clipboard's snapshot covers. */
function snapshotCellCount(clip: ClipboardData): number {
  const sel = clip.sourceSelection;
  return clip.sourceRows.length * (Math.abs(sel.endCol - sel.startCol) + 1);
}

/**
 * Something may have changed what the pending clipboard's source holds -- an
 * undo or redo, a rename, a write onto its cells: read it again -- in the
 * background, or, for a snapshot over SNAPSHOT_EAGER_REREAD_MAX_CELLS, when a
 * paste asks (every paste door waits for it: `settledSnapshot`).
 */
function markSnapshotStale(): void {
  const clip = internalClipboard;
  if (!clip) return;
  staleGeneration += 1;
  if (snapshotPositionsLost) return;
  if (snapshotCellCount(clip) > SNAPSHOT_EAGER_REREAD_MAX_CELLS) return;
  startSnapshotRefresh();
}

/**
 * How many reads one refresh makes for marks that land while it reads. A writer
 * that outpaces the read (a playing animation or a scheduled job writing a
 * precedent of a copied formula on every tick) kept the loop -- and every paste
 * door waiting on it -- going for as long as the writer ran (rev15B). Past the
 * bound the snapshot stays stale and still to be read: the next mark, or the
 * next paste's settle, starts another refresh, and a paste whose settle runs
 * out pastes the snapshot of its last read instead of waiting (see
 * `snapshotReadDuringPaste`).
 */
export const SNAPSHOT_REFRESH_MAX_READS = 3;

/** Start reading a stale snapshot again, unless a read is already under way. */
function startSnapshotRefresh(): void {
  if (snapshotRefresh) return;
  snapshotRefresh = (async () => {
    try {
      // A mark that lands while a read is under way is caught by the loop --
      // a bounded number of times.
      for (
        let reads = 0;
        reads < SNAPSHOT_REFRESH_MAX_READS && internalClipboard && snapshotIsStale() && !snapshotPositionsLost;
        reads++
      ) {
        if (!(await refreshClipboardSnapshot())) break;
      }
    } finally {
      snapshotRefresh = null;
    }
  })();
}

/**
 * Make the pending clipboard's snapshot what its source holds NOW, as far as
 * it can be read: wait for a read under way, and start one a large snapshot
 * deferred (or a failed one left stale). Every paste door asks before it reads
 * the clipboard -- plain Paste, and Paste Special through
 * {@link settledInternalClipboard}.
 */
async function settledSnapshot(): Promise<void> {
  // ONE refresh under way, then at most one more -- never "while one exists":
  // a writer's marks start a new refresh as each one ends, so waiting for
  // them all waited as long as the writer ran (rev15B).
  if (snapshotRefresh) await snapshotRefresh;
  if (internalClipboard && snapshotIsStale() && !snapshotPositionsLost) {
    startSnapshotRefresh();
    if (snapshotRefresh) await snapshotRefresh;
  }
}

/** How many times a paste settles again for marks that keep landing while it waits. */
const PASTE_SETTLE_ROUNDS = 5;

/** How deep plain Paste has started itself again for a source that moved under it (bounded by PASTE_SETTLE_ROUNDS). */
let pasteRestarts = 0;

/** How many re-reads have put a snapshot in the clipboard (see `snapshotReadSerial`). */
let snapshotReads = 0;

/**
 * The re-read that produced each snapshot: its `snapshotReads` number. A
 * snapshot the copy itself made has none.
 */
const snapshotReadSerial = new WeakMap<ClipboardData, number>();

/**
 * Whether `clip` was read from its source AFTER `readsBefore` -- during the
 * paste asking. Such a snapshot is what the source held at that read, moments
 * ago, inside the paste's own gesture.
 *
 * A SOURCE THAT KEEPS CHANGING IS PASTED AS IT STANDS, NEVER REFUSED (misc19,
 * round 19). The bounded settle (rev15B) ended the endless wait under a writer
 * that outpaces the re-read -- an animation playing, a scheduled job -- but
 * then refused every Ctrl+V and Paste Special with "kept changing" for as long
 * as the writer ran. [LIVE] Excel 16 (round 19, misc19/probe3.ps1): with A1 =
 * B1*2 copied, a write of 5 into B1 keeps the copy pending and Paste Values
 * gives 10; a write of 77 onto A1 itself gives 77 -- Excel pastes what the
 * source holds at the paste. Past the bound, a snapshot read during THIS paste
 * is that value (the last read before the write goes out); only a snapshot no
 * read of this paste ever reached is still refused.
 */
function snapshotReadDuringPaste(clip: ClipboardData, readsBefore: number): boolean {
  return (snapshotReadSerial.get(clip) ?? 0) > readsBefore;
}

/**
 * Whether the copy a paste took (`clip`, of the copy `copyTaken`) no longer
 * stands where `clip` says, while that same copy is still pending: it FOLLOWED
 * a shift (an insert above it) or its positions were lost after the paste took
 * it. A paste names its source cells by address (`CellUpdateInput.source`,
 * BUG-0657), so it must name them where they stand at the write; it starts
 * again from the top then (bounded). A copy or cut that ENDED meanwhile and a
 * newer Copy do not count -- nor does a re-read of the same cells: their
 * values are the backend's to read at the write.
 */
function sourceMovedDuringPaste(clip: ClipboardData, copyTaken: number, positionsLostAtStart: boolean): boolean {
  const now = internalClipboard;
  if (now === null || copyGeneration !== copyTaken) return false;
  if (snapshotPositionsLost !== positionsLostAtStart) return true;
  return now !== clip && !sameSourcePositions(now, clip);
}

/** Whether two snapshots of one copy name the same source cells. */
function sameSourcePositions(a: ClipboardData, b: ClipboardData): boolean {
  const sa = a.sourceSelection;
  const sb = b.sourceSelection;
  if (sa.startRow !== sb.startRow || sa.endRow !== sb.endRow || sa.startCol !== sb.startCol || sa.endCol !== sb.endCol) {
    return false;
  }
  if (a.sourceSheetIndex !== b.sourceSheetIndex || a.sourceSheetId !== b.sourceSheetId) return false;
  if (a.sourceTarget?.kind !== b.sourceTarget?.kind || a.sourceTarget?.id !== b.sourceTarget?.id) return false;
  if (a.sourceRows === b.sourceRows) return true;
  return a.sourceRows.length === b.sourceRows.length && a.sourceRows.every((row, i) => row === b.sourceRows[i]);
}

/**
 * THE SOURCE OF A PASTED WRITE (BUG-0657, `CellUpdateInput.source`): the cell a
 * Paste, a Cut + Paste, a drag move or a Ctrl+drag copy writes FROM, so the
 * backend writes what that cell holds AT THE WRITE -- read under the batch's own
 * guards, before any of its writes -- rather than what the frontend last read.
 * Excel pastes what the source holds at the paste [LIVE, misc19/probe3.ps1:
 * with A1 = B1*2 copied, a write of 5 into B1 keeps the copy pending and Paste
 * Values gives 10]; a re-read raced a writer that never stops (an animation, a
 * fast scheduled job) and lost. `sheetIndex` is the source sheet's index NOW;
 * `target` an object's cells (its own coordinates); `move` a MOVE, whose
 * formula lands unshifted (its relocation re-points it), where a copy's is
 * shifted by (destination - source). The write's `value` stays the fallback
 * for what the backend cannot vouch for (a collection value).
 */
function pasteSourceOf(
  sheetIndex: number,
  row: number,
  col: number,
  opts: { target?: CellTargetRef; move?: boolean } = {},
): PasteSource {
  return {
    sheetIndex,
    row,
    col,
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.move ? { unshifted: true } : {}),
  };
}

/**
 * The MOVE claim of a drag move's or a line move's write (`CellUpdateInput.
 * moved`): the sheet cell it moves from, as a Cut + Paste's writes carry it.
 * A batch whose claims move every cell of a data table's range by one offset
 * MOVES the table (`data_tables::whole_table_moves`, NEW-drag-move-whole-table).
 */
function moveClaimOf(sheetIndex: number, row: number, col: number): MovedFrom {
  return { sheetIndex, row, col };
}

/** Whether (row, col) lies in the rectangle (r0, c0)-(r1, c1), inclusive. */
function inRect(row: number, col: number, r0: number, c0: number, r1: number, c1: number): boolean {
  return row >= r0 && row <= r1 && col >= c0 && col <= c1;
}

/**
 * `settledSnapshot`, repeated while a mark that landed during the wait is still
 * to be read (`snapshotAwaitsRead`), a bounded number of times: a stale
 * snapshot is refused as unreadable only when a read of it actually FAILED.
 */
async function settledSnapshotForPaste(): Promise<void> {
  await settledSnapshot();
  for (let i = 0; i < PASTE_SETTLE_ROUNDS && snapshotAwaitsRead(); i++) await settledSnapshot();
}

/**
 * The internal clipboard once its snapshot is settled (see `settledSnapshot`):
 * what a paste door that is not plain Paste reads -- Paste Special, its dialog,
 * the Paste menu's variants -- so it never pastes a snapshot older than its
 * source. Null when nothing is pending (or the mode ended meanwhile) -- and
 * when the snapshot's source may have changed and could not be read again:
 * that clipboard's mode ENDS here, as plain Paste ends it, so no door pastes
 * cells its source no longer holds.
 *
 * A source that kept changing past the bounded settle, so a mark is still to
 * be read, answers the snapshot of the LAST read this call made -- what the
 * source held at that read, as Excel pastes what the source holds at the paste
 * (`snapshotReadDuringPaste`). Only when no read of this call ever landed is it
 * null -- with the copy KEPT pending and the user told, once, to paste again --
 * because the snapshot it holds then is older than the paste and the caller
 * would paste it with no notice (round 16, clip7's remaining (b)). A caller
 * tells "nothing is copied" apart from that refusal by `getInternalClipboard()`,
 * which still answers the pending copy.
 */
export async function settledInternalClipboard(): Promise<ClipboardData | null> {
  const readsBefore = snapshotReads;
  await settledSnapshotForPaste();
  const clip = internalClipboard;
  if (clip && snapshotIsUnreadable(clip)) {
    endClipboardMode();
    return null;
  }
  if (clip && snapshotAwaitsRead() && !snapshotReadDuringPaste(clip, readsBefore)) {
    void alertAsync(
      "The copied cells kept changing while the paste was being prepared, so nothing was pasted. Paste again to paste what they hold now.",
    );
    return null;
  }
  return clip;
}

/**
 * Whether the pending clipboard's snapshot could NOT be brought up to date --
 * its source may hold something else now and the read failed. A paste refuses
 * it rather than paste stale cells. A snapshot whose positions were lost (an
 * edit that cut into a copied block) is not "unreadable": it pastes what it
 * has (see STRUCTURAL CHANGES).
 */
export function snapshotIsUnreadable(clip: ClipboardData | null): boolean {
  return clip !== null && clip === internalClipboard && snapshotIsStale() && !snapshotPositionsLost && snapshotReadFailed;
}

/**
 * Whether `clip`'s recorded source positions still name its source cells NOW,
 * so a paste of it may name them (`CellUpdateInput.source`, BUG-0657) and the
 * backend writes what they hold at the write: `clip` is the pending copy (or a
 * re-read of the same cells), and no structural edit cut into it
 * (`snapshotPositionsLost`). False for a copy that FOLLOWED a shift since
 * `clip` was taken (its cells stand elsewhere now), a copy whose positions
 * were lost, a mode that ended, and a newer copy -- a paste then writes the
 * snapshot it has, as plain Paste does past its bounded restarts. Paste
 * Special asks it when it plans its writes and again right before it sends
 * them.
 */
export function clipboardSourceStandsAt(clip: ClipboardData): boolean {
  const now = internalClipboard;
  if (now === null || snapshotPositionsLost) return false;
  return now === clip || sameSourcePositions(now, clip);
}

/**
 * Whether the pending clipboard's snapshot is stale and still to be READ --
 * marked stale after the last settle (a write that landed while a paste was
 * awaiting something else), with no read of it failed yet.
 */
function snapshotAwaitsRead(): boolean {
  return internalClipboard !== null && snapshotIsStale() && !snapshotPositionsLost && !snapshotReadFailed;
}

/** One position of a re-read: the cell and its stored value. */
interface RereadCell {
  cell: CellData | null;
  value: ClipboardCellValue | null;
}

/**
 * Read the pending clipboard's source cells again and, when nothing replaced
 * the clipboard meanwhile, put them in its snapshot (`cells`, `values`). True
 * when the snapshot is fresh as of the generation read; false when it could not
 * be read (it stays stale -- see CLIPBOARD MODE for what a paste does then).
 */
async function refreshClipboardSnapshot(): Promise<boolean> {
  const clip = internalClipboard;
  if (!clip) return false;
  const generation = staleGeneration;
  const copy = copyGeneration;
  const sel = clip.sourceSelection;
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);
  const rows = clip.sourceRows;
  const width = maxCol - minCol + 1;
  // A read that FAILED: the snapshot stays stale, and is unreadable.
  const failed = (): false => {
    if (copyGeneration === copy) snapshotReadFailed = true;
    return false;
  };
  if (rows.length === 0 || width <= 0) return failed();

  let read: Map<string, RereadCell>;
  // The sheet the source stands on now (null: an object's cells).
  let where: CutSourceSheet | null = null;
  try {
    if (clip.sourceTarget) {
      read = await rereadObjectCells(clip.sourceTarget, rows, minCol, maxCol);
    } else {
      const shown = getGridStateSnapshot()?.sheetContext;
      where = await cutSourceSheetNow(clip, {
        activeSheetIndex: shown?.activeSheetIndex ?? clip.sourceSheetIndex,
        activeSheetId: shown?.activeSheetId,
      });
      if (where === null) return failed();
      read = await rereadSheetCells(where.index, rows, minCol, maxCol);
    }
  } catch (err) {
    console.warn("[Clipboard] The copied or cut cells could not be read again:", err);
    return failed();
  }
  // Replaced or ended meanwhile, or moved under it: not this read's to write.
  if (internalClipboard !== clip || snapshotPositionsLost) return false;

  const cells: (CellData | null)[][] = [];
  const values: (ClipboardCellValue | null)[][] = [];
  for (let r = 0; r < rows.length; r++) {
    const cellRow: (CellData | null)[] = [];
    const valueRow: (ClipboardCellValue | null)[] = [];
    for (let c = 0; c < width; c++) {
      const now = read.get(`${rows[r]},${minCol + c}`);
      const before = clip.cells[r]?.[c] ?? null;
      if (now?.cell) {
        // A COPY carries a data table's body cell as its value (dataTableCopy.ts);
        // a CUT keeps the marker, so its paste is refused as Excel refuses it.
        cellRow.push(clip.isCut ? now.cell : copiedCell(now.cell));
        valueRow.push(now.value);
      } else if (before && !before.formula && (before.display ?? "") === "") {
        // Still empty, and the read cannot see a row or column format that
        // gives an empty position its look: the snapshot's own look stands.
        cellRow.push(before);
        valueRow.push(null);
      } else {
        cellRow.push(null);
        valueRow.push(null);
      }
    }
    cells.push(cellRow);
    values.push(valueRow);
  }

  // What travels WITH the cells follows them too -- Excel's clipboard is the
  // source's (a script writes 77 into a copied A1: Notepad gets 77): the
  // collection texts, the comments and validations, and the text.
  const extras = await rereadExtras(clip, where, cells, rows, minCol);
  if (internalClipboard !== clip || snapshotPositionsLost) return false;
  const text = cellsToText(cells, extras.collectionTexts);
  const refreshed: ClipboardData = {
    ...clip,
    cells,
    values,
    text,
    collectionTexts: extras.collectionTexts.size > 0 ? extras.collectionTexts : undefined,
    comments: extras.comments.size > 0 ? extras.comments : undefined,
    validations: extras.validations.size > 0 ? extras.validations : undefined,
  };
  if (text !== clip.text) {
    // The system clipboard takes the new text only while it still holds what
    // this copy put there: another program's newer copy is not ours to
    // replace, and the internal clipboard then keeps ITS old text too, so the
    // freshness rule still sees the other program's copy as newer.
    const system = await readSystemClipboardText();
    if (internalClipboard !== clip || snapshotPositionsLost) return false;
    if (internalClipboardMatchesSystemText(clip, system)) {
      const written = await writeToSystemClipboard(text, cellsToHtml(cells));
      if (!written) {
        // The system clipboard still holds the OLD text (another process held
        // it open): the internal clipboard keeps that text too, so a later
        // paste still recognises the system clipboard as this copy's and
        // pastes the fresh cells -- never the old text as constants.
        refreshed.text = clip.text;
      } else if (internalClipboard !== clip || snapshotPositionsLost) {
        adoptWrittenText(clip, copy, text);
        return false;
      }
    } else {
      refreshed.text = clip.text;
    }
  }
  internalClipboard = refreshed;
  snapshotReads += 1;
  snapshotReadSerial.set(refreshed, snapshotReads);
  freshGeneration = generation;
  snapshotReadFailed = false;
  return true;
}

/**
 * The system clipboard now holds `text`, written for `clip` (copy generation
 * `copy`) by a re-read whose clipboard changed while it was writing. Whatever
 * stands now must agree with the system clipboard, or the freshness rule takes
 * our own text for another program's newer copy and pastes it as constants:
 *   - the SAME copy, followed or refreshed meanwhile: it takes the text;
 *   - the same copy, its mode ENDED meanwhile: the text written is the ended
 *     copy's now, so a Paste pastes nothing, and it is emptied again;
 *   - a NEWER copy: its text is put back over ours.
 */
function adoptWrittenText(clip: ClipboardData, copy: number, text: string): void {
  const now = internalClipboard;
  if (copyGeneration !== copy) {
    if (now) void writeToSystemClipboard(now.text, cellsToHtml(now.cells));
    return;
  }
  if (now) {
    if (now.text === clip.text) internalClipboard = { ...now, text };
    return;
  }
  const ended = normalizedClipboardText(clip.text);
  if (endedCutText === null || endedCutText === ended) {
    endedCutText = normalizedClipboardText(text);
    void emptyClipboardOfEndedCut(endedCutText);
  }
}

/** What travels with a re-read snapshot's cells. */
interface RereadExtras {
  collectionTexts: Map<string, string>;
  comments: Map<string, Comment>;
  validations: Map<string, DataValidation>;
}

/**
 * The collection texts, comments and validations of a re-read snapshot, from
 * its source sheet (`where`) NOW. A part that cannot be read keeps the copy's
 * own: the comments and validations are read by sheet index, the collection
 * texts only from the sheet on screen (`get_collection_texts` reads no other).
 * An object's cells carry none (see `copyCellRange`).
 */
async function rereadExtras(
  clip: ClipboardData,
  where: CutSourceSheet | null,
  cells: (CellData | null)[][],
  rows: number[],
  minCol: number,
): Promise<RereadExtras> {
  const kept: RereadExtras = {
    collectionTexts: clip.collectionTexts ?? new Map(),
    comments: clip.comments ?? new Map(),
    validations: clip.validations ?? new Map(),
  };
  if (where === null) return kept;
  const width = cells[0]?.length ?? 0;
  const matrixRowOf = new Map<number, number>();
  rows.forEach((absRow, r) => matrixRowOf.set(absRow, r));
  const out: RereadExtras = { ...kept };
  try {
    const comments = new Map<string, Comment>();
    for (const comment of await getCommentsForSheet(where.index)) {
      const r = matrixRowOf.get(comment.row);
      const c = comment.col - minCol;
      if (r === undefined || c < 0 || c >= width) continue;
      comments.set(`${r},${c}`, comment);
    }
    out.comments = comments;
  } catch (err) {
    console.warn("[Clipboard] The copied cells' comments could not be read again:", err);
  }
  try {
    const ranges = await getAllDataValidations(where.index);
    const validations = new Map<string, DataValidation>();
    const maxCol = minCol + width - 1;
    for (let r = 0; r < rows.length; r++) {
      const rowRanges = ranges.filter(
        (vr) => rows[r] >= vr.startRow && rows[r] <= vr.endRow && vr.endCol >= minCol && vr.startCol <= maxCol,
      );
      for (let c = 0; c < width && rowRanges.length > 0; c++) {
        const hit = rowRanges.find((vr) => minCol + c >= vr.startCol && minCol + c <= vr.endCol);
        if (hit) validations.set(`${r},${c}`, hit.validation);
      }
    }
    out.validations = validations;
  } catch (err) {
    console.warn("[Clipboard] The copied cells' validations could not be read again:", err);
  }
  if (where.isActive) out.collectionTexts = await fetchCollectionTexts(cells, rows, minCol);
  return out;
}

/** Most styled-read requests (`getWatchCells`) in one call of a re-read. */
const REREAD_LOOK_BATCH = 10_000;

/**
 * A sheet's cells, by its index NOW, keyed "row,col": the typed read
 * (`getRangeCellsTyped`, SPARSE: only cells the grid holds, a style-only one
 * included) for the stored value and the formula -- which a protected sheet's
 * hidden formula keeps withheld, as the cut's own read did -- asked in bands of
 * SNAPSHOT_REREAD_BAND_CELLS; then the styled read (`getWatchCells`, which
 * answers for any sheet) for the look of exactly those cells, in batches. The
 * cost follows what the source HOLDS, not its area: a whole column of a few
 * hundred values is a dozen band reads and one look read.
 */
async function rereadSheetCells(
  sheetIndex: number,
  rows: readonly number[],
  minCol: number,
  maxCol: number,
): Promise<Map<string, RereadCell>> {
  const typed: TypedCellData[] = [];
  const width = maxCol - minCol + 1;
  const wanted = new Set(rows);
  const perRead = Math.max(1, Math.floor(SNAPSHOT_REREAD_BAND_CELLS / width));
  for (let i = 0; i < rows.length; ) {
    const first = rows[i];
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] - first + 1 <= perRead) j++;
    for (const t of await getRangeCellsTyped(first, minCol, rows[j], maxCol, sheetIndex)) {
      // A band spans the rows between two copied rows too (a collapsed copy).
      if (wanted.has(t.row)) typed.push(t);
    }
    i = j + 1;
  }
  const out = new Map<string, RereadCell>();
  for (let k = 0; k < typed.length; k += REREAD_LOOK_BATCH) {
    const batch = typed.slice(k, k + REREAD_LOOK_BATCH);
    const looks = await getWatchCells(batch.map((t) => [sheetIndex, t.row, t.col] as [number, number, number]));
    batch.forEach((t, n) => {
      const look = looks[n];
      const cell: CellData = {
        ...(look ?? { row: t.row, col: t.col, display: t.display ?? "", formula: null, styleIndex: 0 }),
        row: t.row,
        col: t.col,
        formula: t.formula ?? null,
      };
      out.set(`${t.row},${t.col}`, { cell, value: { type: t.type, value: t.value } });
    });
  }
  return out;
}

/** An object's cells (a floating grid's), through its own styled and typed reads. */
async function rereadObjectCells(
  ref: CellTargetRef,
  rows: readonly number[],
  minCol: number,
  maxCol: number,
): Promise<Map<string, RereadCell>> {
  const minRow = rows[0];
  const maxRow = rows[rows.length - 1];
  const styled = await prefetchTargetCells(ref, minRow, maxRow, minCol, maxCol);
  const values = await readClipboardValues(rows, minCol, maxCol, ref);
  const out = new Map<string, RereadCell>();
  rows.forEach((row, r) => {
    for (let col = minCol; col <= maxCol; col++) {
      const cell = styled.get(`${row},${col}`) ?? null;
      if (cell) out.set(`${row},${col}`, { cell, value: values[r]?.[col - minCol] ?? null });
    }
  });
  return out;
}

/**
 * Whether a cell change lands on the pending clipboard's OWN cells -- the
 * change that makes its snapshot stale (see CLIPBOARD MODE). An object's
 * clipboard never matches (its coordinates are not the sheet's). A copied
 * formula cell whose formula is unchanged matches too (it recalculated): Paste
 * Values and the system clipboard's text carry the value, and Excel pastes the
 * recalculated one [LIVE, rev11B/probe2.ps1]. EVERY change on a copied cell
 * counts, even one that SHOWS the same text: a change announces the DISPLAY,
 * while Paste Values pastes the STORED value (`ClipboardData.values`) --
 * =A1*1.1 under the format 0 shows 110 for both 110 and 110.22, and treating
 * the unchanged display as "fresh" pasted the old 110 (round 15, rev13B). A
 * re-read is bounded anyway (eager up to SNAPSHOT_EAGER_REREAD_MAX_CELLS, lazy
 * above). A change names its sheet by index, absent for the sheet on
 * screen; which off-screen sheet an index names cannot be told without a read,
 * so a change on an off-screen sheet at the clipboard's addresses counts when
 * its sheet is off screen too -- reading it again is the safe answer.
 */
function changeLandsOnCut(clip: ClipboardData, change: CellValueChange): boolean {
  if (clip.sourceTarget) return false;
  const sel = clip.sourceSelection;
  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);
  if (change.row < minRow || change.row > maxRow || change.col < minCol || change.col > maxCol) return false;
  const shown = getGridStateSnapshot()?.sheetContext;
  if (!shown) return true;
  const cutIsShown =
    clip.sourceSheetId && shown.activeSheetId
      ? clip.sourceSheetId === shown.activeSheetId
      : clip.sourceSheetIndex === shown.activeSheetIndex;
  const changeIsShown =
    change.sheetIndex === undefined || change.sheetIndex === null || change.sheetIndex === shown.activeSheetIndex;
  return changeIsShown ? cutIsShown : !cutIsShown;
}

/**
 * The announcements that end the clipboard mode, a Copy's and a Cut's,
 * whatever they carry (see CLIPBOARD MODE). Read when the listeners are
 * installed, never at module load: a module-level read of the event names
 * broke every test that mocks the events module without them and merely
 * IMPORTS this file through @api.
 */
function clipboardModeEndings(): string[] {
  return [
    AppEvents.EDIT_STARTED,
    AppEvents.STYLE_ENTRIES_UPDATED,
    // ROWS_INSERTED / COLUMNS_INSERTED end it too, except the insert that
    // makes room for the copy's own paste (`onLinesInserted`).
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_DELETED,
    // A sheet deleted (Excel ends the mode on ANY sheet's delete [LIVE]).
    AppEvents.SHEET_DELETED,
    // A Sort, a Remove Duplicates, a Text to Columns, an AutoFilter's criteria,
    // a Merge or Unmerge, Calculate Now / Calculate Sheet -- from any route,
    // the ribbon's or a script's (Excel ends the mode on each [LIVE]).
    ApiAppEvents.DATA_COMMAND_APPLIED,
    // File > New / Open and a checkout replace the document the cells came
    // from (core/lib/file-api.ts `announceBackendStateReplaced`).
    "grid:documentReplaced",
  ];
}

/** The outline commands (OUTLINE_CHANGED's `command`) that end the clipboard mode, as Excel's do [LIVE]. */
const OUTLINE_COMMANDS_ENDING_THE_MODE: ReadonlySet<string> = new Set([
  "group_rows",
  "ungroup_rows",
  "group_columns",
  "ungroup_columns",
  "clear_outline",
]);

/**
 * Who re-draws the marching ants when a pending copy's source FOLLOWED a shift
 * (`followCopySource`): each mounted `useClipboard`.
 */
const sourceFollowedListeners = new Set<(clip: ClipboardData) => void>();

/** The copied block's rectangle and rows after one line edit, or null when the edit cuts into it. */
function shiftedSourceBlock(
  edit: StructuralLineEdit,
  sel: Selection,
  rows: readonly number[],
): { sel: Selection; rows: number[] } | null | "unmoved" {
  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);
  const rowWise = edit.kind === "rowInsert" || edit.kind === "rowDelete";
  const insert = edit.kind === "rowInsert" || edit.kind === "colInsert";
  // The band across the edit: the block must lie wholly inside it or wholly outside.
  const [p0, p1] = rowWise ? [minCol, maxCol] : [minRow, maxRow];
  if (edit.band) {
    if (p1 < edit.band.start || p0 > edit.band.end) return "unmoved";
    if (p0 < edit.band.start || p1 > edit.band.end) return null;
  }
  const [lo, hi] = rowWise ? [minRow, maxRow] : [minCol, maxCol];
  let delta: number;
  if (insert) {
    if (edit.at > hi) return "unmoved";
    if (edit.at > lo) return null;
    delta = edit.count;
  } else {
    const last = edit.at + edit.count - 1;
    if (edit.at > hi) return "unmoved";
    if (last >= lo) return null;
    delta = -edit.count;
  }
  if (rowWise) {
    return {
      sel: { ...sel, startRow: sel.startRow + delta, endRow: sel.endRow + delta },
      rows: rows.map((r) => r + delta),
    };
  }
  return { sel: { ...sel, startCol: sel.startCol + delta, endCol: sel.endCol + delta }, rows: [...rows] };
}

/**
 * A pending COPY's source FOLLOWS row and column edits on its sheet, as
 * Excel's does (see STRUCTURAL CHANGES): its address moves with its cells, the
 * marching ants with it, and the snapshot is read again there. An edit that
 * cuts into the copied block leaves the snapshot as it is, never read again by
 * address. A cut is never followed (those edits end it).
 */
function followCopySource(edits: readonly StructuralLineEdit[]): void {
  const clip = internalClipboard;
  if (!clip || clip.isCut || clip.sourceTarget) return;
  let sel = clip.sourceSelection;
  let rows = clip.sourceRows;
  let moved = false;
  for (const edit of edits) {
    if (edit.sheetIndex !== clip.sourceSheetIndex) continue;
    const next = shiftedSourceBlock(edit, sel, rows);
    if (next === "unmoved") continue;
    if (next === null) {
      snapshotPositionsLost = true;
      return;
    }
    sel = next.sel;
    rows = next.rows;
    moved = true;
  }
  if (!moved) return;
  const followed: ClipboardData = { ...clip, sourceSelection: sel, sourceRows: rows };
  internalClipboard = followed;
  for (const listener of [...sourceFollowedListeners]) listener(followed);
  markSnapshotStale();
}

/** Whether a line edit DELETES lines or cells (which ends a copy as well as a cut). */
function isDeleteEdit(edit: StructuralLineEdit): boolean {
  return edit.kind === "rowDelete" || edit.kind === "colDelete";
}

/** The line edits a STRUCTURAL_EDIT_ELSEWHERE / STRUCTURAL_UNDO payload names on real sheets. */
function lineEditsOf(raw: unknown): StructuralLineEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: StructuralLineEdit[] = [];
  for (const e of raw as Array<Partial<StructuralLineEdit> | null>) {
    if (!e || typeof e.sheetIndex !== "number" || typeof e.at !== "number" || typeof e.count !== "number") continue;
    if (e.kind !== "rowInsert" && e.kind !== "rowDelete" && e.kind !== "colInsert" && e.kind !== "colDelete") continue;
    out.push({ sheetIndex: e.sheetIndex, kind: e.kind, at: e.at, count: e.count, ...(e.band ? { band: e.band } : {}) });
  }
  return out;
}

/**
 * Listen for the announcements that END the clipboard mode, or make its
 * snapshot STALE (see CLIPBOARD MODE). Returns the unsubscribe.
 */
export function listenForClipboardModeEndings(target: Window = window): () => void {
  const endings = clipboardModeEndings();
  const structuralElsewhere = ApiAppEvents.STRUCTURAL_EDIT_ELSEWHERE;
  const structuralUndo = ApiAppEvents.STRUCTURAL_UNDO;
  const cellValuesChanged = AppEvents.CELL_VALUES_CHANGED;
  const mutationRefresh = AppEvents.MUTATION_REFRESH;
  const sheetRenamed = AppEvents.SHEET_RENAMED;
  const sheetAdded = AppEvents.SHEET_ADDED;
  const end = (): void => {
    endClipboardMode();
  };
  // Group / Ungroup / Clear Outline end the mode; collapsing, expanding and
  // showing a level keep it (they hide lines, which keeps it) [LIVE 2026-10-30,
  // clip5/probe-endings.ps1]. The outline wrappers name their command.
  const outlineChanged = AppEvents.OUTLINE_CHANGED;
  const onOutlineChanged = (event: Event): void => {
    const command = (event as CustomEvent<{ command?: unknown } | undefined>).detail?.command;
    if (typeof command === "string" && OUTLINE_COMMANDS_ENDING_THE_MODE.has(command)) endClipboardMode();
  };
  // A row or column insert on the sheet on screen ends the mode (Excel's
  // ribbon Insert Sheet Rows [LIVE]) -- except the insert Insert Copied Cells
  // makes for the copy's own paste, which KEEPS the copy and moves its source
  // with its cells [LIVE 2026-10-30, clip4/probe-insert*.ps1: row 6 copied,
  // row 2 selected, Insert Copied Cells -> the copy stays pending].
  // Only the ONE insert the call expects (its kind, lines and count), once:
  // another insert that lands while that call is in flight -- a script's, a
  // second door's -- is an ordinary insert and ends the copy.
  const onLinesInserted = (kind: "rowInsert" | "colInsert") => (event: Event): void => {
    const clip = internalClipboard;
    const expected = copyInsertExpected;
    if (expected && expected.kind === kind && clip && !clip.isCut) {
      const d = (event as CustomEvent<{ startRow?: number; startCol?: number; count?: number } | undefined>).detail;
      const at = kind === "rowInsert" ? d?.startRow : d?.startCol;
      const sheetIndex = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
      if (at === expected.at && d?.count === expected.count && typeof sheetIndex === "number") {
        copyInsertExpected = null;
        followCopySource([{ sheetIndex, kind, at, count: expected.count }]);
        return;
      }
    }
    endClipboardMode();
  };
  const onRowsInserted = onLinesInserted("rowInsert");
  const onColumnsInserted = onLinesInserted("colInsert");
  const endCutKeepCopy = (): void => {
    if (endCutMode()) return;
    if (internalClipboard) snapshotPositionsLost = true;
  };
  // A script's row / column edit on any sheet: ends a cut (Excel [LIVE]); a
  // DELETE ends a copy too, and an insert moves a copy's source with the
  // edits on its sheet.
  const onStructuralElsewhere = (event: Event): void => {
    const detail = (event as CustomEvent<Partial<StructuralEditElsewherePayload> | undefined>).detail;
    const edits = lineEditsOf(detail?.edits);
    if (edits.some(isDeleteEdit)) {
      endClipboardMode();
      return;
    }
    if (endCutMode()) return;
    followCopySource(edits);
  };
  // An Undo / Redo of a structural step keeps both modes and the ADDRESS: the
  // snapshot is read again where it was (Excel [LIVE]). An Insert / Delete Cells
  // band ends a cut and moves a copy's source. Anything else that cannot say
  // what moved: a cut ends, a copy pastes the snapshot it has.
  const onStructuralUndo = (event: Event): void => {
    const detail = (event as CustomEvent<Partial<StructuralUndoPayload> | undefined>).detail;
    if (detail?.source === "undo" || detail?.source === "redo") {
      markSnapshotStale();
      return;
    }
    // A gesture taken back to its savepoint (Insert Copied Cells whose paste
    // did not land): it never happened, so a copy's source that followed its
    // insert follows the inverse back -- the next Paste takes the cells it
    // copied, not the ones the insert pushed onto their address -- and a
    // delta in it ends nothing. The snapshot is read again where it is.
    if (detail?.source === "rollback") {
      followCopySource(lineEditsOf(detail.deltas));
      markSnapshotStale();
      return;
    }
    if (detail?.source === "edit" && Array.isArray(detail.deltas)) {
      const edits = lineEditsOf(detail.deltas);
      // Delete Cells ends a copy as well as a cut, wherever it lands (Excel
      // [LIVE]); Insert Cells ends a cut and moves a copy's source.
      if (edits.some(isDeleteEdit)) {
        endClipboardMode();
        return;
      }
      if (endCutMode()) return;
      followCopySource(edits);
      return;
    }
    endCutKeepCopy();
  };
  const onCellValues = (event: Event): void => {
    const clip = internalClipboard;
    if (!clip) return;
    const payload = (event as CustomEvent<CellValuesChangedPayload | undefined>).detail;
    if (!payload) return;
    // A clear or a fill anywhere ends the mode (Excel [LIVE]).
    if (payload.source === "clear" || payload.source === "fill") {
      endClipboardMode();
      return;
    }
    // An undo or redo, or any other write onto the clipboard's cells, keeps it
    // -- and the paste must take what the source holds now.
    if (payload.source === "undo" || payload.source === "redo") {
      markSnapshotStale();
      return;
    }
    if ((payload.changes ?? []).some((change) => changeLandsOnCut(clip, change))) markSnapshotStale();
  };
  const onMutationRefresh = (event: Event): void => {
    const source = (event as CustomEvent<Partial<MutationRefreshPayload> | undefined>).detail?.source;
    if (source === "undo" || source === "redo") markSnapshotStale();
  };
  // A rename keeps the mode; the snapshot's formulas must spell the new name.
  const onRenamed = (): void => {
    markSnapshotStale();
  };
  // A sheet COPIED ends the mode (Excel [LIVE]); a sheet merely added keeps it.
  const onAdded = (event: Event): void => {
    const source = (event as CustomEvent<{ source?: string } | undefined>).detail?.source;
    if (source === "copy") endClipboardMode();
  };
  // A sheet MOVED ends the mode (Excel [LIVE]): `sheet:reorder` naming two real
  // indices. An insertion or a removal is told with BEYOND_EVERY_SHEET at one
  // end, and is not a move (a delete ends it through SHEET_DELETED).
  const onReorder = (event: Event): void => {
    const detail = (event as CustomEvent<{ fromIndex?: unknown; toIndex?: unknown } | undefined>).detail;
    const from = detail?.fromIndex;
    const to = detail?.toIndex;
    if (typeof from !== "number" || typeof to !== "number" || from === to) return;
    if (from >= BEYOND_EVERY_SHEET || to >= BEYOND_EVERY_SHEET) {
      // A sheet inserted or removed keeps the mode; the source's index follows
      // its sheet, so the edits that name the sheet by index still find it.
      const clip = internalClipboard;
      if (!clip || clip.sourceTarget) return;
      const now = renumberedSheetIndex(clip.sourceSheetIndex, from, to);
      if (now === null || now === clip.sourceSheetIndex) return;
      const followed: ClipboardData = { ...clip, sourceSheetIndex: now };
      internalClipboard = followed;
      for (const listener of [...sourceFollowedListeners]) listener(followed);
      return;
    }
    endClipboardMode();
  };
  for (const name of endings) target.addEventListener(name, end);
  target.addEventListener(AppEvents.ROWS_INSERTED, onRowsInserted);
  target.addEventListener(AppEvents.COLUMNS_INSERTED, onColumnsInserted);
  target.addEventListener(structuralElsewhere, onStructuralElsewhere);
  target.addEventListener(structuralUndo, onStructuralUndo);
  target.addEventListener(cellValuesChanged, onCellValues);
  target.addEventListener(mutationRefresh, onMutationRefresh);
  target.addEventListener(sheetRenamed, onRenamed);
  target.addEventListener(sheetAdded, onAdded);
  target.addEventListener("sheet:reorder", onReorder);
  target.addEventListener(outlineChanged, onOutlineChanged);
  return () => {
    target.removeEventListener(outlineChanged, onOutlineChanged);
    for (const name of endings) target.removeEventListener(name, end);
    target.removeEventListener(AppEvents.ROWS_INSERTED, onRowsInserted);
    target.removeEventListener(AppEvents.COLUMNS_INSERTED, onColumnsInserted);
    target.removeEventListener(structuralElsewhere, onStructuralElsewhere);
    target.removeEventListener(structuralUndo, onStructuralUndo);
    target.removeEventListener(cellValuesChanged, onCellValues);
    target.removeEventListener(mutationRefresh, onMutationRefresh);
    target.removeEventListener(sheetRenamed, onRenamed);
    target.removeEventListener(sheetAdded, onAdded);
    target.removeEventListener("sheet:reorder", onReorder);
  };
}

// ============================================================================
// INSERT COPIED CELLS
// ============================================================================
//
// With a COPY pending, Excel's Insert becomes "Insert Copied Cells": it makes
// room for the copied block where the selection is and pastes it there, as
// ONE undo step, and the copy stays pending with its source moved along with
// its cells. Live Excel 16 [2026-10-30, clip4/probe-insert.ps1 and
// probe-insert2.ps1, fresh visible instances]:
//   - Home > Insert > the Cells... row reads "Insert Copied Cells..." (and
//     "Insert Copied Cells", no dialog, over whole rows); Ctrl+Plus opens the
//     "Insert" dialog with Shift cells right / Shift cells down;
//   - F6 copied, F2 selected, Shift cells down -> F2 = f6, column F shifted
//     down, =F6 reads =F7, CutCopyMode stays xlCopy, a later Paste pastes f6
//     (from F7: the source followed); one Ctrl+Z takes it all back;
//   - A1:B1 copied, F2 selected -> the room made is the COPY's size (F2:G2);
//     F6:F7 copied, F2:F4 selected -> two cells (the copy's size again);
//     a selection that is a MULTIPLE of the copy is the room, filled with the
//     copy tiled [LIVE round 13, clip5/probe-insert-tile.ps1: F6 into F2:F3
//     -> f6 twice; rows 6:7 into rows 2:5 -> the pair twice];
//   - row 6 copied, row 2 selected -> the copied row is inserted at row 2;
//     F6 copied, row 2 selected -> refused, "This selection isn't valid...";
//   - a ribbon Insert Sheet Rows inserts a BLANK row and ends the copy.
// The decisions (which shape, which dialog, which refusal) are the
// InsertDeleteCells extension's; this is the primitive: make the room, paste
// the pending copy there, all or nothing.

/**
 * The ONE whole-line insert Insert Copied Cells is making, while its call is
 * in flight: the room for the copy's own paste. The announcement that matches
 * it (kind, first line, count) moves a copy's source instead of ending the
 * mode, and consumes it (`onLinesInserted`); any other insert ends the mode as
 * usual. Scoped to that one call -- set before its insert, cleared however the
 * call ends -- so a concurrent insert can never borrow it.
 */
let copyInsertExpected: { kind: "rowInsert" | "colInsert"; at: number; count: number } | null = null;

/** The sheet's last row / column index (0-based): Excel's 1,048,576 x XFD, as the cell-shift wrapper reads a band. */
const SHEET_LAST_ROW = 1_048_575;
const SHEET_LAST_COL = 16_383;

/** The whole-line insert an Insert Copied Cells request makes, or null (a cell band, announced as a band). */
function expectedLineInsert(request: InsertCopiedCellsRequest): { kind: "rowInsert" | "colInsert"; at: number; count: number } | null {
  if (request.kind === "rows") return { kind: "rowInsert", at: request.start, count: request.count };
  if (request.kind === "columns") return { kind: "colInsert", at: request.start, count: request.count };
  const r0 = Math.min(request.startRow, request.endRow);
  const r1 = Math.max(request.startRow, request.endRow);
  const c0 = Math.min(request.startCol, request.endCol);
  const c1 = Math.max(request.startCol, request.endCol);
  // A band spanning every column (row) is inserted as whole rows (columns) by
  // the cell-shift wrapper, which then announces ROWS_ / COLUMNS_INSERTED.
  if (c0 === 0 && c1 >= SHEET_LAST_COL) return { kind: "rowInsert", at: r0, count: r1 - r0 + 1 };
  if (r0 === 0 && r1 >= SHEET_LAST_ROW) return { kind: "colInsert", at: c0, count: c1 - c0 + 1 };
  return null;
}

/** How many pastes have LANDED (committed their writes): Insert Copied Cells asks whether its paste did. */
let pastesLanded = 0;

/** Where Insert Copied Cells makes room for the copy (the active sheet's coordinates). */
export type InsertCopiedCellsRequest =
  | { kind: "cells"; startRow: number; startCol: number; endRow: number; endCol: number; shift: "right" | "down" }
  | { kind: "rows"; start: number; count: number }
  | { kind: "columns"; start: number; count: number };

/** What Insert Copied Cells did: `inserted`, or why not (null when the user was already told, or answered Cancel). */
export type InsertCopiedCellsResult = { inserted: true } | { inserted: false; message: string | null };

/** The pending COPY of sheet cells Insert Copied Cells would paste, or null (none, a cut, an object's cells). */
export function pendingCopyOfSheetCells(): ClipboardData | null {
  const clip = internalClipboard;
  if (!clip || clip.isCut || clip.sourceTarget) return null;
  return clip;
}

/**
 * The word Excel's menus use for the Insert command while a copy is pending
 * [LIVE]: "Insert Copied Cells..." (a dialog follows), "Insert Copied Cells"
 * over whole rows or columns (none does). Null when no copy of sheet cells is
 * pending: the menu keeps its own word.
 */
export function insertCopiedCellsLabel(wholeLines: boolean): string | null {
  if (!pendingCopyOfSheetCells()) return null;
  return wholeLines ? "Insert Copied Cells" : "Insert Copied Cells...";
}

/**
 * Excel's Insert Copied Cells on the ACTIVE sheet: make room (`request`) and
 * paste the pending copy at its top-left, as ONE undo step ("Insert Copied
 * Cells"). All or nothing: a refused insert changes nothing, and a paste that
 * does not land takes the insert back (the point is marked before anything is
 * written). The copy stays pending afterwards, its source moved with its
 * cells. Never throws.
 */
export async function insertCopiedCells(request: InsertCopiedCellsRequest): Promise<InsertCopiedCellsResult> {
  if (!pendingCopyOfSheetCells()) {
    return { inserted: false, message: "There are no copied cells to insert. Copy the cells first." };
  }
  const label = "Insert Copied Cells";
  let tx: OwnedUndoTransaction | null = null;
  try {
    tx = ownUndoTransaction(await beginUndoTransaction(label), UNDO_CLOSES);
  } catch (err) {
    return { inserted: false, message: errorText(err) };
  }
  const marked = await markMovePoint(label);
  if (marked.point === null) {
    await tx.cancel().catch(() => {});
    return {
      inserted: false,
      message: `The copied cells were not inserted: an insert is taken back whole when it cannot finish, and that could not be arranged right now (${marked.why}). Nothing was changed.`,
    };
  }
  const point = marked.point;
  // Taken back to the point: the step holds nothing, and is closed empty.
  const takeBack = async (message: string | null): Promise<InsertCopiedCellsResult> => {
    const notTakenBack = await takeBackRefusedMove(point);
    if (notTakenBack === null) {
      await tx?.cancel().catch(() => {});
      return { inserted: false, message };
    }
    await tx?.commit().catch(() => {});
    return {
      inserted: false,
      message: `The copied cells could not be pasted, and the cells inserted for them could not be taken back (${notTakenBack}). Undo takes them back.`,
    };
  };

  // The expectation covers the insert calls only (never the user's answer to
  // a question), names THIS insert alone, and is released however the call
  // ends -- unless another call has replaced it meanwhile.
  const lineInsert = expectedLineInsert(request);
  const held = async <T,>(insert: () => Promise<T>): Promise<T> => {
    const mine = lineInsert ? { ...lineInsert } : null;
    if (mine) copyInsertExpected = mine;
    try {
      return await insert();
    } finally {
      if (mine && copyInsertExpected === mine) copyInsertExpected = null;
    }
  };
  // The room made, top-left and bottom-right: a room that is a multiple of the
  // copy is filled by the copy TILED (`pasteTiles`), as Excel's Insert Copied
  // Cells fills it [LIVE, clip5/probe-insert-tile.ps1].
  let at: { row: number; col: number; endRow: number; endCol: number };
  try {
    if (request.kind === "cells") {
      const rect = request;
      let result = await held(() => insertCellsRange(rect.startRow, rect.startCol, rect.endRow, rect.endCol, rect.shift));
      if (!result.applied && result.confirm) {
        if (!(await confirmAsync(result.confirm, { title: "Insert", kind: "warning" }))) {
          await tx.cancel().catch(() => {});
          return { inserted: false, message: null };
        }
        result = await held(() =>
          insertCellsRange(rect.startRow, rect.startCol, rect.endRow, rect.endCol, rect.shift, {
            unmergeCutMerges: true,
          }),
        );
      }
      if (!result.applied) {
        await tx.cancel().catch(() => {});
        return { inserted: false, message: "The cells could not be inserted. Nothing was changed." };
      }
      at = {
        row: Math.min(rect.startRow, rect.endRow),
        col: Math.min(rect.startCol, rect.endCol),
        endRow: Math.max(rect.startRow, rect.endRow),
        endCol: Math.max(rect.startCol, rect.endCol),
      };
    } else if (request.kind === "rows") {
      const { start, count } = request;
      await held(() => insertRows(start, count));
      const copied = pendingCopyOfSheetCells();
      const width = copied ? Math.abs(copied.sourceSelection.endCol - copied.sourceSelection.startCol) + 1 : 1;
      at = { row: start, col: 0, endRow: start + count - 1, endCol: width - 1 };
    } else {
      const { start, count } = request;
      await held(() => insertColumns(start, count));
      const copied = pendingCopyOfSheetCells();
      const height = copied ? copied.sourceRows.length : 1;
      at = { row: 0, col: start, endRow: height - 1, endCol: start + count - 1 };
    }
  } catch (err) {
    // A refused insert wrote nothing; whatever did land is taken back.
    return takeBack(errorText(err));
  }

  // The copy's own paste, through the grid command every Paste door runs, at
  // the room just made; it JOINS this step.
  const before = pastesLanded;
  try {
    await gridCommands.execute("paste", { at });
  } catch (err) {
    return takeBack(errorText(err));
  }
  if (pastesLanded === before) {
    // The paste was refused (and said why) or found nothing to paste.
    return takeBack(null);
  }
  try {
    await tx.commit();
  } catch (err) {
    return { inserted: false, message: errorText(err) };
  }
  return { inserted: true };
}

/**
 * The `{ at }` a grid command's paste was handed (Insert Copied Cells), or
 * null: the top-left cell, and -- when the room is larger than the copy (a
 * multiple of it, which the paste TILES) -- its bottom-right `endRow` /
 * `endCol`.
 */
function pasteDestinationOf(args: unknown): { row: number; col: number; endRow: number; endCol: number } | null {
  const at = (args as { at?: { row?: unknown; col?: unknown; endRow?: unknown; endCol?: unknown } } | null | undefined)?.at;
  if (!at) return null;
  const { row, col } = at;
  if (typeof row !== "number" || typeof col !== "number") return null;
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0) return null;
  const corner = (end: unknown, start: number): number =>
    typeof end === "number" && Number.isSafeInteger(end) && end >= start ? end : start;
  return { row, col, endRow: corner(at.endRow, row), endCol: corner(at.endCol, col) };
}

// ============================================================================
// Is the internal clipboard still what the clipboard holds?
// ============================================================================
//
// The internal clipboard is Calcula's own record of the last Copy / Cut -- the
// cells WITH their formulas, styles, comments and validations. The SYSTEM
// clipboard is shared with every other program. When the user copies in
// Notepad after copying cells, the system clipboard holds the newer text and
// the internal record is stale: pasting it would paste cells the user no longer
// has on the clipboard.
//
// Plain Paste always asked (it compares the system text with the text the copy
// wrote there, and pastes the system text when they differ). The Paste Special
// variants never did: after a copy in Notepad, Paste Values pasted the OLD
// Calcula cells (clipboard survey defect 3). ONE rule, exported, so every paste
// door asks the same question the same way -- a second spelling would drift
// on the first change (Windows line endings were the first one).

/**
 * THE freshness rule: the internal clipboard is CURRENT when the system
 * clipboard holds the very text the copy wrote there (line endings
 * normalised -- Windows hands `\r\n` back), or holds nothing readable at all.
 * Different text means another program copied after Calcula did.
 */
export function internalClipboardMatchesSystemText(
  clipboard: Pick<ClipboardData, "text">,
  systemText: string | null | undefined,
): boolean {
  const normalized = systemText?.replace(/\r\n/g, "\n") ?? null;
  return !normalized || normalized === clipboard.text;
}

/**
 * Read the system clipboard's text, or null when it cannot be read (no Tauri
 * runtime, a clipboard another process holds open). A failed read is "nothing
 * newer", never a refusal: plain Paste has always fallen back to the internal
 * clipboard then.
 */
async function readSystemClipboardText(): Promise<string | null> {
  try {
    return await tauriReadText();
  } catch (err) {
    console.warn("[Clipboard] Could not read from system clipboard:", err);
    return null;
  }
}

/**
 * Whether `clipboard` (the internal clipboard a paste is about to use) is
 * still what the clipboard holds -- {@link internalClipboardMatchesSystemText}
 * against a fresh read of the system clipboard. The Paste Special variants
 * ask this before they paste (@api/cellClipboard); plain Paste applies the
 * same rule to the text it reads anyway.
 */
export async function internalClipboardIsCurrent(clipboard: Pick<ClipboardData, "text">): Promise<boolean> {
  return internalClipboardMatchesSystemText(clipboard, await readSystemClipboardText());
}

/**
 * Detect collection cells (List/Dict) in a cell matrix and fetch their JSON representations.
 * Returns a Map keyed by "row,col" (relative to the matrix) with JSON text values.
 */
async function fetchCollectionTexts(
  cells: (CellData | null)[][],
  sourceRows: number[],
  minCol: number,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  // Collect absolute coordinates of collection cells. The absolute row comes
  // from sourceRows — a collapsed (filtered) copy has gaps.
  const collectionCoords: { r: number; c: number; absRow: number; absCol: number }[] = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r][c];
      if (cell?.display && (cell.display.startsWith("[List(") || cell.display.startsWith("[Dict("))) {
        collectionCoords.push({ r, c, absRow: sourceRows[r], absCol: minCol + c });
      }
    }
  }

  if (collectionCoords.length === 0) return result;

  try {
    const coords: [number, number][] = collectionCoords.map(({ absRow, absCol }) => [absRow, absCol]);
    const jsonTexts = await getCollectionTexts(coords);
    for (let i = 0; i < collectionCoords.length; i++) {
      const { r, c } = collectionCoords[i];
      if (jsonTexts[i]) {
        result.set(`${r},${c}`, jsonTexts[i]);
      }
    }
  } catch (err) {
    console.warn("[Clipboard] Failed to fetch collection texts:", err);
  }

  return result;
}

/**
 * Fetch comments for cells in a selection range.
 * Returns a Map keyed by "row,col" (relative to the matrix) with Comment values.
 */
async function fetchComments(
  cells: (CellData | null)[][],
  sourceRows: number[],
  minCol: number,
): Promise<Map<string, Comment>> {
  const result = new Map<string, Comment>();

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      try {
        const comment = await getComment(sourceRows[r], minCol + c);
        if (comment) {
          result.set(`${r},${c}`, comment);
        }
      } catch {
        // Cell has no comment or API error — skip
      }
    }
  }

  return result;
}

/**
 * Fetch data validations for cells in a selection range.
 * Returns a Map keyed by "row,col" (relative to the matrix) with DataValidation values.
 */
async function fetchValidations(
  cells: (CellData | null)[][],
  sourceRows: number[],
  minCol: number,
): Promise<Map<string, DataValidation>> {
  const result = new Map<string, DataValidation>();

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      try {
        const validation = await getDataValidation(sourceRows[r], minCol + c);
        if (validation) {
          result.set(`${r},${c}`, validation);
        }
      } catch {
        // Cell has no validation or API error — skip
      }
    }
  }

  return result;
}

/**
 * Convert cell matrix to an HTML table for pasting into Excel and other apps.
 */
function cellsToHtml(cells: (CellData | null)[][]): string {
  const rows = cells.map((row) => {
    const tds = row.map((cell) => {
      const value = cell?.display ?? "";
      // Escape HTML entities
      const escaped = value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      return `<td>${escaped}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");
  return `<table>${rows}</table>`;
}

/**
 * Write text and HTML to the system clipboard via Tauri plugin. Answers whether
 * the system clipboard now holds `text` -- false when neither write landed
 * (another process holding the clipboard open): a caller that records what the
 * clipboard holds must then keep the text it had.
 */
async function writeToSystemClipboard(text: string, html: string): Promise<boolean> {
  try {
    // Write HTML (which includes alt plain-text fallback)
    await tauriWriteHtml(html, text);
    console.log("[Clipboard] Written to system clipboard (HTML + text)");
    return true;
  } catch (err) {
    // Fall back to plain text only
    try {
      await tauriWriteText(text);
      console.log("[Clipboard] Written to system clipboard (text only)");
      return true;
    } catch (err2) {
      console.warn("[Clipboard] Could not write to system clipboard:", err2);
      return false;
    }
  }
}

/**
 * Convert cell matrix to plain text (tab-separated values).
 * For List/Dict cells, uses JSON representation instead of display text.
 */
function cellsToText(
  cells: (CellData | null)[][],
  collectionTexts?: Map<string, string>,
): string {
  return cells
    .map((row, r) =>
      row
        .map((cell, c) => {
          if (!cell) return "";
          // Use JSON text for collection cells if available
          const jsonText = collectionTexts?.get(`${r},${c}`);
          if (jsonText) return jsonText;
          // Use formula if present, otherwise display value
          return cell.formula || cell.display || "";
        })
        .join("\t")
    )
    .join("\n");
}

// ============================================================================
// copyCellRange -- the COPY primitive, outside React
// ============================================================================
//
// The hook's Copy (Ctrl+C on the grid, Home > Copy, Edit > Copy) is a copy of
// Core's selection. A floating object whose cells live in the active sheet's
// grid -- a canvas pivot box, whose hidden grid holds the rendered pivot --
// selects its OWN cells, which Core's selection never sees, and must still
// copy them the way Copy copies cells: the same internal clipboard (so Paste,
// Paste Special and Paste Link read it), the same system clipboard text and
// HTML. One primitive, called by both; the hook adds what belongs to Core's
// selection only (the marching ants, the cut source).

/** What {@link copyCellRange} copies. Coordinates are absolute sheet cells of the ACTIVE sheet. */
export interface CellRangeCopyRequest {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Rows left out of a COPY (a filtered range's hidden rows; a pivot's zero-height rows). */
  skipRows?: ReadonlySet<number>;
  /**
   * Read the rectangle in batched `getViewportCells` calls (<= 10,000 cells each)
   * instead of one `getCell` IPC per cell (`captureClipboardCells` awaits one
   * read per cell, in series). Comments and validations are then read with one
   * call each for the whole sheet instead of one per cell. Core's own Copy keeps
   * the per-cell read (unchanged behaviour); the pivot copy passes true.
   */
  batchRead?: boolean;
  /** Cap on cells read; defaults to MAX_CLIPBOARD_CELLS (5,000,000). The pivot copy passes 200,000. */
  maxCells?: number;
  /**
   * Copy an OBJECT's cells instead of the active sheet's (a floating grid's,
   * P3): the coordinates are the object's own, read through its styled read
   * (`getCellTargetCells`), and the clipboard records the object as its
   * source (`ClipboardData.sourceTarget`, named `label`). Comments and
   * validations are not read: their stores are the active sheet's, and an
   * object's (row, col) would read the host's.
   */
  target?: { ref: CellTargetRef; label: string };
}

/** What {@link copyCellRange} did. A refusal never touches the clipboard that was there. */
export type CellRangeCopyResult =
  | { copied: true; rows: number; cols: number }
  | { copied: false; reason: "empty" | "tooLarge" | "failed" };

/** Largest rectangle one batched read asks the backend for. */
const BATCH_READ_MAX_CELLS = 10_000;

/**
 * Read the copyable `rows` (ascending) of columns `minCol..maxCol` in
 * rectangles of at most {@link BATCH_READ_MAX_CELLS} cells, into a map keyed
 * "row,col". A rectangle spans the rows between two copyable rows too (a
 * skipped row inside it costs a few cells, not an extra IPC), and ends where
 * the next copyable row would push it over the budget. A cell the backend does
 * not return is EMPTY (`get_viewport_cells` sends only cells with content or a
 * style, which is when `get_cell` answers null).
 */
async function prefetchCells(
  rows: readonly number[],
  minCol: number,
  maxCol: number,
): Promise<Map<string, CellData>> {
  const map = new Map<string, CellData>();
  if (rows.length === 0) return map;
  for (let bandStart = minCol; bandStart <= maxCol; bandStart += BATCH_READ_MAX_CELLS) {
    const bandEnd = Math.min(maxCol, bandStart + BATCH_READ_MAX_CELLS - 1);
    const bandWidth = bandEnd - bandStart + 1;
    const rowsPerRead = Math.max(1, Math.floor(BATCH_READ_MAX_CELLS / bandWidth));
    let i = 0;
    while (i < rows.length) {
      const first = rows[i];
      let j = i;
      while (j + 1 < rows.length && rows[j + 1] - first + 1 <= rowsPerRead) j++;
      const last = rows[j];
      const cells = await getViewportCells(first, bandStart, last, bandEnd);
      for (const cell of cells) {
        if (cell.row < first || cell.row > last || cell.col < bandStart || cell.col > bandEnd) continue;
        map.set(`${cell.row},${cell.col}`, cell);
      }
      i = j + 1;
    }
  }
  return map;
}

/**
 * Comments of the captured cells from ONE read of the active sheet's comments
 * (the batched twin of {@link fetchComments}). Keyed "row,col" relative to the
 * matrix.
 */
async function fetchCommentsBatched(
  cells: (CellData | null)[][],
  sourceRows: number[],
  minCol: number,
): Promise<Map<string, Comment>> {
  const result = new Map<string, Comment>();
  const width = cells[0]?.length ?? 0;
  if (cells.length === 0 || width === 0) return result;
  let all: Comment[];
  try {
    all = await getAllComments();
  } catch (err) {
    console.warn("[Clipboard] Failed to read comments:", err);
    return result;
  }
  const matrixRowOf = new Map<number, number>();
  sourceRows.forEach((absRow, r) => matrixRowOf.set(absRow, r));
  for (const comment of all) {
    const r = matrixRowOf.get(comment.row);
    const c = comment.col - minCol;
    if (r === undefined || c < 0 || c >= width) continue;
    result.set(`${r},${c}`, comment);
  }
  return result;
}

/**
 * Validations of the captured cells from ONE read of the active sheet's
 * validation ranges (the batched twin of {@link fetchValidations}). The FIRST
 * range that contains a cell answers for it, as `get_data_validation` does.
 */
async function fetchValidationsBatched(
  cells: (CellData | null)[][],
  sourceRows: number[],
  minCol: number,
): Promise<Map<string, DataValidation>> {
  const result = new Map<string, DataValidation>();
  const width = cells[0]?.length ?? 0;
  if (cells.length === 0 || width === 0) return result;
  let ranges: ValidationRange[];
  try {
    ranges = await getAllDataValidations();
  } catch (err) {
    console.warn("[Clipboard] Failed to read data validations:", err);
    return result;
  }
  if (ranges.length === 0) return result;
  const maxCol = minCol + width - 1;
  for (let r = 0; r < sourceRows.length; r++) {
    const absRow = sourceRows[r];
    const rowRanges = ranges.filter(
      (vr) => absRow >= vr.startRow && absRow <= vr.endRow && vr.endCol >= minCol && vr.startCol <= maxCol,
    );
    if (rowRanges.length === 0) continue;
    for (let c = 0; c < width; c++) {
      const absCol = minCol + c;
      const hit = rowRanges.find((vr) => absCol >= vr.startCol && absCol <= vr.endCol);
      if (hit) result.set(`${r},${c}`, hit.validation);
    }
  }
  return result;
}

/**
 * An object's cells over a rectangle (its own coordinates), keyed "row,col",
 * through its styled read (banded by `getCellTargetCells`). A cell the read
 * does not return is EMPTY.
 */
async function prefetchTargetCells(
  ref: CellTargetRef,
  minRow: number,
  maxRow: number,
  minCol: number,
  maxCol: number,
): Promise<Map<string, CellData>> {
  const read = await getCellTargetCells(ref, { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol });
  const map = new Map<string, CellData>();
  for (const cell of read.cells) map.set(`${cell.row},${cell.col}`, cell);
  return map;
}

/**
 * The copied cells' stored values (`ClipboardData.values`), or undefined when
 * they cannot be read typed -- the copy still happens, and its paste falls
 * back to the display text (the old route) for that copy only.
 */
async function captureValues(
  sourceRows: readonly number[],
  minCol: number,
  maxCol: number,
  target?: CellTargetRef,
): Promise<(ClipboardCellValue | null)[][] | undefined> {
  try {
    return await readClipboardValues(sourceRows, minCol, maxCol, target);
  } catch (err) {
    console.warn("[Clipboard] The copied cells could not be read typed; their paste uses the display text:", err);
    return undefined;
  }
}

/**
 * The stored values of the cells a MOVE or a Ctrl+drag COPY reads (a sparse
 * read: `getViewportCells`, `getCellsInRows`, `getCellsInCols`), keyed
 * "row,col", read typed over their bounding box (in the backend's bands).
 * Null when they cannot be read: the gesture then writes the display text, as
 * it did before.
 */
async function storedValuesOf(cells: readonly CellData[]): Promise<Map<string, ClipboardCellValue> | null> {
  if (cells.length === 0) return new Map();
  let r0 = Infinity;
  let r1 = -Infinity;
  let c0 = Infinity;
  let c1 = -Infinity;
  for (const cell of cells) {
    if (cell.row < r0) r0 = cell.row;
    if (cell.row > r1) r1 = cell.row;
    if (cell.col < c0) c0 = cell.col;
    if (cell.col > c1) c1 = cell.col;
  }
  try {
    return await readStoredValues(r0, c0, r1, c1);
  } catch (err) {
    console.warn("[Clipboard] The cells could not be read typed; the move writes their display text:", err);
    return null;
  }
}

/**
 * The formulas a Ctrl+drag COPY writes, shifted the Excel way, keyed by their
 * SOURCE "row,col": a copy moves each relative reference with the cell
 * (`=A1` Ctrl+dragged from B1 to C2 is `=B2`; Excel, measured live through COM
 * 2026-10-29, Range.Copy Destination), exactly as Copy + Paste does. The drag
 * copies wrote every formula unshifted, so a copied `=A1` still read A1.
 */
async function shiftedCopyFormulas(
  cells: readonly CellData[],
  rowDelta: number,
  colDelta: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rowDelta === 0 && colDelta === 0) return out;
  const withFormula = cells.filter((c) => !!c.formula);
  if (withFormula.length === 0) return out;
  const shifted = await shiftFormulasBatch(
    withFormula.map((c) => ({ formula: c.formula as string, rowDelta, colDelta })),
  );
  withFormula.forEach((c, i) => out.set(`${c.row},${c.col}`, shifted[i]));
  return out;
}

/**
 * What a MOVE or a Ctrl+drag COPY writes for one source cell: its formula
 * (shifted by the caller) when it has one, else its STORED value invariant
 * (`pastedConstantInput`) -- dragging 1.23456 shown under 0.00 moved it as
 * 1.23, silently, exactly as Paste did -- and the display text only when the
 * stored values could not be read.
 *
 * A formula or a stored value is flagged as a PASTE (`pasted`, the backend
 * decides it in the same write): a moved number or formula that lands in a
 * Text-formatted (@) destination -- written before the cell takes the
 * source's style -- stays a number or a formula, as Excel moves it. The
 * display-text fallback stays an entry, as before.
 */
function movedCellInput(
  cell: CellData | undefined,
  formula: string | null | undefined,
  stored: Map<string, ClipboardCellValue> | null,
): { value: string; invariant?: true; pasted?: true } {
  if (formula) return { value: formula, pasted: true };
  if (stored && cell) {
    const constant = pastedConstantInput(stored.get(`${cell.row},${cell.col}`), cell.display ?? "");
    if (constant) return { value: constant.value, invariant: true, pasted: true };
  }
  return { value: cell?.display ?? "" };
}

/** Whether two cell targets name the same object. */
function sameTarget(a: CellTargetRef | undefined, b: CellTargetRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id;
}

/** Where a SHEET cut's source sheet is at the paste. */
interface CutSourceSheet {
  /** Its index in the workbook NOW. */
  index: number;
  /** Whether it is the active sheet, the one a plain paste writes. */
  isActive: boolean;
}

/**
 * Where the sheet a CUT came from is now, found by the stable id the cut
 * recorded (`ClipboardData.sourceSheetId`) -- `null` when no sheet carries it
 * any more (the sheet was deleted).
 *
 * Nothing ends a cut on a sheet switch (Excel keeps the marching ants too), so
 * a paste can land on ANOTHER sheet; the cut's source must then be cleared on
 * ITS sheet, never by the active-sheet `clearCell`, which erased the
 * destination sheet's cells at the source's addresses and left the source
 * intact. The index recorded at the cut goes stale when a sheet is inserted,
 * moved or deleted before it, so the id decides; the recorded index is the
 * fallback only when there is no id to go by (or the sheet list cannot be
 * read). No IPC when the active sheet IS the source.
 */
async function cutSourceSheetNow(
  clip: ClipboardData,
  context: { activeSheetIndex: number; activeSheetId?: string },
): Promise<CutSourceSheet | null> {
  const recorded: CutSourceSheet = {
    index: clip.sourceSheetIndex,
    isActive: clip.sourceSheetIndex === context.activeSheetIndex,
  };
  const id = clip.sourceSheetId;
  if (!id) return recorded;
  if (context.activeSheetId && context.activeSheetId === id) {
    return { index: context.activeSheetIndex, isActive: true };
  }
  let list: { sheets: { index: number; sheetId?: string }[]; activeIndex: number };
  try {
    list = await getSheets();
  } catch (err) {
    console.warn("[Clipboard] the sheet list could not be read; using the sheet recorded at the cut:", err);
    return recorded;
  }
  const sheets = list?.sheets ?? [];
  if (!sheets.some((s) => s.sheetId)) return recorded;
  const sheet = sheets.find((s) => s.sheetId === id);
  if (!sheet) return null;
  return { index: sheet.index, isActive: sheet.index === list.activeIndex };
}

/** The message a refused or failed write of a cut's source shows. */
function errorText(err: unknown): string {
  return typeof err === "string" ? err : (err as Error)?.message || String(err);
}

// ============================================================================
// A CUT'S PASTE IS ALL OR NOTHING
// ============================================================================
//
// A cut's paste writes the destination FIRST -- its formulas UNSHIFTED, which is
// right only for a move: the relocation that follows the source's clear
// re-points them (and, between sheets, re-qualifies them). When the source
// could not be emptied -- a protected source sheet, part of a spill, a pivot, a
// writeback claim -- the paste used to stay behind as a "copy" with a message
// saying so, and its formulas were neither copy-shifted nor re-qualified: Cut
// Sheet1!A1:A2 (7, =A1+B5) on a protected Sheet1, Paste on Sheet2 at D4, and
// Sheet2!D5 held =A1+B5, reading SHEET2's A1 and B5 (review rev6A#5; on one
// sheet the relocation then re-pointed references to cells that never moved).
// Excel never moves half [LIVE, 2026-10-30, cutmode/probe-refusals.ps1]: it
// refuses the Cut of a locked cell on a protected sheet, protecting the source
// after the cut ends cut mode so the Paste does nothing, Cut Destination onto
// another sheet is refused whole, and a spill's child cell pastes nothing.
//
// The source's gates cannot all be asked before the write -- a source on
// another sheet has no protection, spill or claim query this side can make --
// so the paste marks an undo SAVEPOINT inside its own step before it writes
// (`markMovePoint`), and on the first refusal of the source's clear, or of the
// relocation that makes it a move, it TAKES EVERYTHING BACK to that point
// (`takeBackRefusedMove`, the restore Ctrl+Z uses, leaving no undo or redo
// step) and says why: nothing was pasted. A cut whose step cannot carry a point
// (another macro you started holds it) is refused before anything is written.

/** The point a cut's paste can be taken back to, or why it has none. */
type MovePoint = { point: UndoSavepoint; why?: undefined } | { point: null; why: string };

/** Excel's words for a copied block pasted where it would run past the sheet's edge [LIVE]. */
export const PASTE_PAST_THE_EDGE =
  "You can't paste this here because the Copy area and paste area aren't the same size.\n\n" +
  "Select just one cell in the paste area or an area that's the same size, and try pasting again.";

/** Excel's words for a cut block moved (pasted or dragged) where it would run past the sheet's edge [LIVE]. */
export const MOVE_PAST_THE_EDGE =
  "This selection isn't valid.\n\nMake sure the copy and paste areas don't overlap unless they are the same size and shape.";

/**
 * Mark the point a cut's paste is taken back to (A CUT'S PASTE IS ALL OR
 * NOTHING), inside the step the paste already holds: the savepoint door JOINS
 * it. A begin that OPENED a step instead -- the paste's own closed underneath
 * it -- is closed again at once: nobody else would ever close it.
 */
async function markMovePoint(description: string): Promise<MovePoint> {
  let answer: Awaited<ReturnType<typeof beginUndoSavepoint>> | null;
  try {
    answer = await beginUndoSavepoint(description);
  } catch (err) {
    return { point: null, why: errorText(err) };
  }
  const opened = typeof answer?.ticket === "number" ? answer.ticket : null;
  if (opened !== null) {
    await cancelUndoTransaction(opened).catch(() => {});
    return { point: null, why: "the undo step the paste opened was closed while it was being pasted" };
  }
  const point = answer?.savepoint;
  if (point && Number.isSafeInteger(point.transaction) && Number.isSafeInteger(point.changes)) {
    return { point: { transaction: point.transaction, changes: point.changes } };
  }
  const refused = typeof answer?.refused === "string" ? answer.refused.trim() : "";
  return {
    point: null,
    why: refused !== "" ? refused : "the undo step it would be recorded in cannot be named as a point to return to",
  };
}

/**
 * Take a refused move back to its point, every change the paste made -- the
 * destination's write and any part of the source already cleared -- through the
 * restore Ctrl+Z uses. Null when it was taken back; otherwise why not.
 * A take-back is SHOWN the way Ctrl+Z shows a restore
 * (`announceRolledBackRestore`): the lines it took back are announced with
 * their inverse deltas, so what followed the gesture's insert -- the pending
 * copy's source, bookmarks, watches -- follows it back, and the dimensions and
 * cells are re-read.
 */
async function takeBackRefusedMove(point: UndoSavepoint): Promise<string | null> {
  try {
    const result = await rollBackToUndoSavepoint(point);
    if (result?.success === true) {
      try {
        announceRolledBackRestore(result, point.transaction);
      } catch (err) {
        console.error("[Clipboard] The take-back could not be shown:", err);
      }
      return null;
    }
    const refusal = typeof result?.refusal === "string" ? result.refusal.trim() : "";
    return refusal !== "" ? refusal : "the undo history did not take it back";
  } catch (err) {
    return errorText(err);
  }
}

/**
 * Whether a paste's selection on the ACTIVE sheet holds a merged cell -- which
 * makes Excel paste the copy once instead of tiling it [LIVE,
 * clip5/probe-tile.ps1]. A read that fails answers true: pasted once, the
 * paste Calcula has always made.
 */
async function selectionHoldsMergedCells(selection: Selection): Promise<boolean> {
  try {
    const regions = await getMergedRegions({
      startRow: selection.startRow,
      startCol: selection.startCol,
      endRow: selection.endRow,
      endCol: selection.endCol,
    });
    return Array.isArray(regions) ? regions.length > 0 : true;
  } catch (err) {
    console.warn("[Clipboard] The merged cells under the paste could not be read; the copy is pasted once:", err);
    return true;
  }
}

/** The OBJECT target a grid command was handed, or null for Core's selection. */
function objectTargetOf(ctx?: GridCommandContext): Extract<CellTarget, { kind: "object" }> | null {
  const t = ctx?.target;
  return t && t.kind === "object" ? t : null;
}

/**
 * Copy a range of the ACTIVE sheet to the internal + system clipboard. Never
 * touches Core's selection or the marching ants (the hook's `copy` dispatches
 * setClipboard itself after calling this).
 *
 * A refusal ("empty": every row skipped; "tooLarge": over the cap) leaves the
 * clipboard as it was, and so does "failed" (a read threw): the caller tells
 * the user -- nothing here is console-only for a caller that asks.
 */
export async function copyCellRange(range: CellRangeCopyRequest): Promise<CellRangeCopyResult> {
  const snapshot = getGridStateSnapshot();
  const target = range.target;
  // An object source is never a sheet: -1 (see ClipboardData.sourceTarget).
  const sourceSheetIndex = target ? -1 : snapshot?.sheetContext?.activeSheetIndex ?? 0;
  const sourceSheetName = target ? target.label : snapshot?.sheetContext?.activeSheetName ?? "";
  // The sheet's stable id, so a paste finds it after a rename (BUG-0348).
  const sourceSheetId = target ? undefined : snapshot?.sheetContext?.activeSheetId;

  const minRow = Math.min(range.startRow, range.endRow);
  const maxRow = Math.max(range.startRow, range.endRow);
  const minCol = Math.min(range.startCol, range.endCol);
  const maxCol = Math.max(range.startCol, range.endCol);
  const width = maxCol - minCol + 1;
  const maxCells = range.maxCells ?? MAX_CLIPBOARD_CELLS;

  try {
    let readCell: (row: number, col: number) => Promise<CellData | null>;
    if (target) {
      // An object's cells: ONE styled read of the rectangle (banded), after the
      // same cap, so an oversized range costs no read at all.
      const rows = copyableSourceRows(minRow, maxRow, range.skipRows, false);
      if (rows.length * width > maxCells) {
        console.warn(`[Clipboard] Range too large for clipboard (${rows.length * width} cells). Skipping.`);
        return { copied: false, reason: "tooLarge" };
      }
      const prefetched = await prefetchTargetCells(target.ref, minRow, maxRow, minCol, maxCol);
      readCell = async (r, c) => prefetched.get(`${r},${c}`) ?? null;
    } else if (range.batchRead) {
      // The cap first -- the SAME count captureClipboardCells uses (copyable
      // rows x width) -- so an oversized range costs no read at all.
      const rows = copyableSourceRows(minRow, maxRow, range.skipRows, false);
      if (rows.length * width > maxCells) {
        console.warn(`[Clipboard] Range too large for clipboard (${rows.length * width} cells). Skipping.`);
        return { copied: false, reason: "tooLarge" };
      }
      const prefetched = await prefetchCells(rows, minCol, maxCol);
      readCell = async (r, c) => prefetched.get(`${r},${c}`) ?? null;
    } else {
      readCell = async (r, c) => (await getCell(r, c)) || null;
    }

    // COPY takes the rows not skipped: a range spanning filter-hidden rows
    // copies just the displayed cells, which then slide together and paste
    // as a contiguous rectangle (Excel's filtered-copy rule).
    const capture = await captureClipboardCells<CellData>({
      minRow,
      maxRow,
      minCol,
      maxCol,
      filterHiddenRows: range.skipRows,
      includeFilterHidden: false,
      readCell,
      maxCells,
    });

    if (capture.tooLarge) {
      // Guard against unreasonably large ranges (e.g. select-all on 1M x 16K grid)
      console.warn(
        `[Clipboard] Range too large for clipboard ` +
        `(${(maxRow - minRow + 1) * width} cells). Skipping.`
      );
      return { copied: false, reason: "tooLarge" };
    }

    // A data table's body cell is copied as its VALUE (Excel [LIVE]; see
    // dataTableCopy.ts): its `=TABLE(..)` marker is not a formula a paste may write.
    const cells = capture.cells.map((row) => row.map((cell) => copiedCell(cell)));
    const { sourceRows } = capture;
    if (cells.length === 0) {
      // Nothing capturable (every row skipped). Leave the previous clipboard
      // alone rather than replacing it with an empty payload that pastes
      // nothing.
      console.warn("[Clipboard] Nothing to copy in this selection");
      return { copied: false, reason: "empty" };
    }

    // Detect collection cells and fetch their JSON representations; fetch
    // comments and validations for paste special support. Not for an object:
    // each of these reads the ACTIVE sheet's store by (row, col).
    const collectionTexts = target
      ? new Map<string, string>()
      : await fetchCollectionTexts(cells, sourceRows, minCol);
    const comments = target
      ? new Map<string, Comment>()
      : range.batchRead
        ? await fetchCommentsBatched(cells, sourceRows, minCol)
        : await fetchComments(cells, sourceRows, minCol);
    const validations = target
      ? new Map<string, DataValidation>()
      : range.batchRead
        ? await fetchValidationsBatched(cells, sourceRows, minCol)
        : await fetchValidations(cells, sourceRows, minCol);

    const text = cellsToText(cells, collectionTexts);
    // The stored values a paste of a constant writes (never its display text).
    const values = await captureValues(sourceRows, minCol, maxCol, target?.ref);

    // Store in internal clipboard
    rememberClipboard({
      sourceSelection: {
        startRow: range.startRow,
        startCol: range.startCol,
        endRow: range.endRow,
        endCol: range.endCol,
        type: "cells",
      },
      cells,
      sourceRows,
      isCut: false,
      sourceSheetIndex,
      sourceSheetName,
      ...(sourceSheetId ? { sourceSheetId } : {}),
      ...(target ? { sourceTarget: target.ref } : {}),
      ...(values ? { values } : {}),
      text,
      collectionTexts: collectionTexts.size > 0 ? collectionTexts : undefined,
      comments: comments.size > 0 ? comments : undefined,
      validations: validations.size > 0 ? validations : undefined,
    });

    // Write to system clipboard (HTML for Excel, plain text for Notepad)
    const html = cellsToHtml(cells);
    await writeToSystemClipboard(text, html);

    return { copied: true, rows: cells.length, cols: width };
  } catch (error) {
    console.error("[Clipboard] Copy failed:", error);
    return { copied: false, reason: "failed" };
  }
}

/**
 * Hook for clipboard operations.
 */
export function useClipboard(): UseClipboardReturn {
  const { state, dispatch } = useGridContext();
  const { selection, config, clipboard, sheetContext, dimensions } = state;
  // Core's own selection, under the name the paste uses beside an object's.
  const coreSelection = selection;

  // The FILTER source only. Hand hides and outline collapses are copied by
  // Excel, so the effective union (dimensions.hiddenRows) must not be used here.
  const filterHiddenRows = dimensions.filterHiddenRows;

  // Ref to track cut source for clearing after paste
  const cutSourceRef = useRef<Selection | null>(null);

  // Whether a copy or cut is pending, as RENDER state: the host re-renders
  // when one starts or ends, so what it derives from `isClipboardModeLive()`
  // while rendering -- the grid keyboard's "Esc has something to clear"
  // (useSpreadsheetSelection) -- is current. A floating grid's copy or cut
  // draws no marching ants and dispatches nothing, so nothing re-rendered after it.
  useSyncExternalStore(subscribeToCutMode, isClipboardModeLive, isClipboardModeLive);

  // CLIPBOARD MODE's endings (Esc is clearClipboardState below): while this
  // hook is mounted, the announcements that end a pending copy or cut end it,
  // and an ended one takes its marching ants down.
  useEffect(() => {
    const takeAntsDown = (): void => {
      dispatch(clearClipboard());
    };
    // A copy whose source followed a shift: its ants move with it.
    const moveAnts = (clip: ClipboardData): void => {
      if (clip.sourceTarget) return;
      dispatch(setClipboard(clip.isCut ? "cut" : "copy", { ...clip.sourceSelection }, clip.sourceSheetIndex));
    };
    cutEndedListeners.add(takeAntsDown);
    sourceFollowedListeners.add(moveAnts);
    const stopListening = listenForClipboardModeEndings();
    return () => {
      cutEndedListeners.delete(takeAntsDown);
      sourceFollowedListeners.delete(moveAnts);
      stopListening();
    };
  }, [dispatch]);

  /**
   * Get cell data for a range, applying Excel's hidden-row rule.
   *
   * @param includeFilterHidden true for CUT (whole rectangle), false for a
   *        COPY (filter-hidden rows are left behind and the block collapses).
   *        Copy itself goes through {@link copyCellRange}; Cut reads here.
   */
  const getCellRange = useCallback(
    async (
      sel: Selection,
      includeFilterHidden: boolean
    ): Promise<{ cells: (CellData | null)[][]; sourceRows: number[]; minCol: number }> => {
      const minRow = Math.min(sel.startRow, sel.endRow);
      const maxRow = Math.max(sel.startRow, sel.endRow);
      const minCol = Math.min(sel.startCol, sel.endCol);
      const maxCol = Math.max(sel.startCol, sel.endCol);

      const capture = await captureClipboardCells<CellData>({
        minRow,
        maxRow,
        minCol,
        maxCol,
        filterHiddenRows,
        includeFilterHidden,
        readCell: async (r, c) => (await getCell(r, c)) || null,
      });

      if (capture.tooLarge) {
        // Guard against unreasonably large ranges (e.g. select-all on 1M x 16K grid)
        console.warn(
          `[useClipboard] Range too large for clipboard ` +
          `(${(maxRow - minRow + 1) * (maxCol - minCol + 1)} cells). Skipping.`
        );
      }

      return { cells: capture.cells, sourceRows: capture.sourceRows, minCol };
    },
    [filterHiddenRows]
  );

  /**
   * Copy selected cells to clipboard.
   *
   * The copy itself is {@link copyCellRange} (shared with an object's inner
   * cell selection); what is Core's selection's own stays here: the marching
   * ants and forgetting a pending cut.
   */
  const copy = useCallback(async (_args?: unknown, ctx?: GridCommandContext) => {
    const owned = objectTargetOf(ctx);
    if (owned) {
      // An OBJECT's cells (a floating grid's, P3): copied from the object, in
      // its own coordinates. No marching ants: Core's ants are drawn on the
      // ACTIVE sheet, where the object's coordinates would name the host's cells.
      const sel = owned.selection;
      const result = await copyCellRange({
        startRow: sel.startRow,
        startCol: sel.startCol,
        endRow: sel.endRow,
        endCol: sel.endCol,
        target: { ref: owned.ref, label: owned.label },
      });
      if (!result.copied) return;
      cutSourceRef.current = null;
      return;
    }
    if (!selection) {
      console.log("[Clipboard] No selection to copy");
      return;
    }

    console.log("[Clipboard] Copying selection:", selection);

    // COPY takes VISIBLE rows only: the FILTER-hidden rows are skipped (Excel's
    // filtered-copy rule); hand hides and outline collapses are copied.
    const result = await copyCellRange({
      startRow: selection.startRow,
      startCol: selection.startCol,
      endRow: selection.endRow,
      endCol: selection.endCol,
      skipRows: filterHiddenRows,
    });
    // Refused or failed: copyCellRange said why on the console and left the
    // previous clipboard (and its marching ants) as they were.
    if (!result.copied) return;

    // Update state for visual feedback (marching ants border)
    dispatch(setClipboard("copy", { ...selection }, sheetContext.activeSheetIndex));

    // Clear any previous cut source
    cutSourceRef.current = null;
  }, [selection, filterHiddenRows, dispatch, sheetContext.activeSheetIndex]);

  /**
   * Cut an OBJECT's cells (a floating grid's, P3): the whole rectangle of its
   * selection, read through its styled read, recorded with the object as the
   * source. The source is cleared through the same target when it is pasted
   * (see paste). No marching ants (they belong to the active sheet's cells).
   */
  const cutTarget = useCallback(async (owned: Extract<CellTarget, { kind: "object" }>) => {
    const sel = owned.selection;
    const minRow = Math.min(sel.startRow, sel.endRow);
    const maxRow = Math.max(sel.startRow, sel.endRow);
    const minCol = Math.min(sel.startCol, sel.endCol);
    const maxCol = Math.max(sel.startCol, sel.endCol);
    try {
      const prefetched = await prefetchTargetCells(owned.ref, minRow, maxRow, minCol, maxCol);
      const capture = await captureClipboardCells<CellData>({
        minRow,
        maxRow,
        minCol,
        maxCol,
        includeFilterHidden: true,
        readCell: async (r, c) => prefetched.get(`${r},${c}`) ?? null,
      });
      if (capture.tooLarge || capture.cells.length === 0) {
        console.warn("[Clipboard] Nothing to cut in this selection");
        return;
      }
      const { cells, sourceRows } = capture;
      const text = cellsToText(cells, new Map());
      const values = await captureValues(sourceRows, minCol, maxCol, owned.ref);
      rememberClipboard({
        sourceSelection: { ...sel },
        cells,
        sourceRows,
        isCut: true,
        sourceSheetIndex: -1,
        sourceSheetName: owned.label,
        sourceTarget: owned.ref,
        ...(values ? { values } : {}),
        text,
      });
      cutSourceRef.current = { ...sel };
      await writeToSystemClipboard(text, cellsToHtml(cells));
    } catch (error) {
      console.error("[Clipboard] Cut failed:", error);
    }
  }, []);

  /**
   * Cut selected cells to clipboard.
   */
  const cut = useCallback(async (_args?: unknown, ctx?: GridCommandContext) => {
    const owned = objectTargetOf(ctx);
    if (owned) {
      await cutTarget(owned);
      return;
    }
    if (!selection) {
      console.log("[Clipboard] No selection to cut");
      return;
    }

    console.log("[Clipboard] Cutting selection:", selection);

    try {
      // CUT takes the WHOLE rectangle, filter-hidden rows included — Excel
      // "will cut everything in between the top and bottom of your selection".
      // The source-clearing pass below clears that same whole rectangle, so
      // the two halves of the gesture stay in agreement and nothing is
      // silently left behind or silently erased.
      const { cells, sourceRows, minCol } = await getCellRange(selection, true);

      if (cells.length === 0) {
        console.warn("[Clipboard] Nothing to cut in this selection");
        return;
      }

      // Detect collection cells and fetch their JSON representations
      const collectionTexts = await fetchCollectionTexts(cells, sourceRows, minCol);

      // Fetch comments and validations for paste special support
      const comments = await fetchComments(cells, sourceRows, minCol);
      const validations = await fetchValidations(cells, sourceRows, minCol);

      const text = cellsToText(cells, collectionTexts);
      // The stored values a paste of a constant writes (never its display text).
      const values = await captureValues(sourceRows, minCol, Math.max(selection.startCol, selection.endCol));

      // Store in internal clipboard with cut flag
      rememberClipboard({
        sourceSelection: { ...selection },
        cells,
        sourceRows,
        isCut: true,
        sourceSheetIndex: sheetContext.activeSheetIndex,
        sourceSheetName: sheetContext.activeSheetName,
        ...(sheetContext.activeSheetId ? { sourceSheetId: sheetContext.activeSheetId } : {}),
        ...(values ? { values } : {}),
        text,
        collectionTexts: collectionTexts.size > 0 ? collectionTexts : undefined,
        comments: comments.size > 0 ? comments : undefined,
        validations: validations.size > 0 ? validations : undefined,
      });

      // Remember cut source for clearing after paste
      cutSourceRef.current = { ...selection };

      // Update state for visual feedback (marching ants border)
      dispatch(setClipboard("cut", { ...selection }, sheetContext.activeSheetIndex));

      // Write to system clipboard (HTML for Excel, plain text for Notepad)
      const html = cellsToHtml(cells);
      await writeToSystemClipboard(text, html);
    } catch (error) {
      console.error("[Clipboard] Cut failed:", error);
    }
  }, [selection, getCellRange, cutTarget, dispatch, sheetContext.activeSheetIndex, sheetContext.activeSheetName, sheetContext.activeSheetId]);

  /**
   * Paste clipboard contents to current selection -- or, handed an OBJECT
   * target by the grid-command door (a floating grid's cells, P3), to the
   * object's selection: written with `updateCellsBatch(.., { target })`, with
   * Excel's relative shift on the object's own (backing) coordinates.
   */
  const paste = useCallback(async (args?: unknown, ctx?: GridCommandContext) => {
    const owned = objectTargetOf(ctx);
    // `{ at: { row, col } }`: paste with that cell as the top-left (Insert
    // Copied Cells, into the room it made) rather than at Core's selection.
    const at = owned ? null : pasteDestinationOf(args);
    const selection: Selection | null = owned
      ? owned.selection
      : at
        ? { startRow: at.row, startCol: at.col, endRow: at.endRow, endCol: at.endCol, type: "cells" }
        : coreSelection;
    const destRef = owned?.ref;
    // The destination's size: the object's write extent, or the sheet's.
    const totalRows = owned ? owned.bounds.rows : config.totalRows;
    const totalCols = owned ? owned.bounds.cols : config.totalCols;
    if (!selection) {
      console.log("[Clipboard] No selection for paste target");
      return;
    }

    console.log("[Clipboard] Pasting to selection:", selection);

    // A read of a stale snapshot under way (an undo, a rename, a write onto
    // the source since the copy or cut -- see CLIPBOARD MODE): the paste waits
    // for it (bounded), so the formats and the text it pastes are the source's
    // NOW. The VALUES are not the frontend's to chase: every write names its
    // source cell (`pasteSourceOf`) and the backend reads it at the write.
    await settledSnapshotForPaste();

    // Try to read from system clipboard first (via Tauri plugin). A write onto
    // the source that lands while this read is under way is read again before
    // the paste goes on -- never refused as "could not be read" (only a read
    // that FAILED makes a snapshot unreadable) -- and the text read again,
    // since the re-read may have put new text on the clipboard.
    let textToPaste = await readSystemClipboardText();
    for (let i = 0; i < PASTE_SETTLE_ROUNDS && snapshotAwaitsRead(); i++) {
      await settledSnapshotForPaste();
      textToPaste = await readSystemClipboardText();
    }

    // Determine what to paste
    let cellsToPaste: (CellData | null)[][] | null = null;
    let pasteWidth = 1;
    let pasteHeight = 1;
    // Track if we're using internal clipboard (for deciding whether to clear after paste)
    let usingInternalClipboard = false;

    // THE clipboard this paste uses, held for the whole paste: a cut that ENDS
    // while the paste is under way (an announcement landing between its awaits)
    // must not swap the source it is moving out from under it.
    const clip = internalClipboard;
    // Which copy this paste took, and whether it still knew where its source
    // stands (see `sourceMovedDuringPaste`).
    const copyTaken = copyGeneration;
    const positionsLostAtTake = snapshotPositionsLost;

    // THE freshness rule (shared with every Paste Special variant): the
    // internal clipboard answers unless another program put newer text there.
    if (clip && internalClipboardMatchesSystemText(clip, textToPaste)) {
      // Use internal clipboard (preserves formulas, formatting, etc.)
      cellsToPaste = clip.cells;
      pasteHeight = cellsToPaste.length;
      pasteWidth = cellsToPaste[0]?.length || 1;
      usingInternalClipboard = true;
      console.log("[Clipboard] Using internal clipboard data");
    } else if (isEndedCutText(textToPaste)) {
      // What a copy or cut whose mode ENDED left on the clipboard (it could not
      // be emptied): Excel pastes nothing once the mode is over (see CLIPBOARD MODE).
      console.log("[Clipboard] The copy or cut ended; nothing to paste");
      return;
    } else if (textToPaste) {
      // Parse text from system clipboard (tab/newline separated)
      const rows = textToPaste.split("\n");
      cellsToPaste = rows.map((row) =>
        row.split("\t").map((value) => ({
          row: 0,
          col: 0,
          display: value,
          formula: null,
          styleIndex: 0,
        }))
      );
      pasteHeight = cellsToPaste.length;
      // The widest line, found by a LOOP: `Math.max(...rows.map(..))` passed
      // one call argument per line, and V8 throws RangeError somewhere above
      // ~125,000 arguments, so Ctrl+V of a long column copied from another
      // program pasted nothing (BUG-0346; the Paste Special twin is
      // pasteSpecialExecute.ts `matrixSize`).
      pasteWidth = 1;
      for (const line of cellsToPaste) {
        if (line.length > pasteWidth) pasteWidth = line.length;
      }
      console.log("[Clipboard] Parsed system clipboard text");
    }

    if (!cellsToPaste || cellsToPaste.length === 0) {
      console.log("[Clipboard] Nothing to paste");
      return;
    }

    // Determine target range
    const targetRow = Math.min(selection.startRow, selection.endRow);
    const targetCol = Math.min(selection.startCol, selection.endCol);

    // A COPY pasted into a selection that is an exact multiple of it is TILED
    // over the selection, each tile's formulas shifted to where it lands; a
    // selection holding a merged cell, or of any other size, takes it once
    // (Excel [LIVE]: see core/lib/pasteTiling.ts). A cut never tiles (Excel
    // refuses a cut into a larger selection), nor does an object's paste.
    let tiles: PasteTiles = PASTE_ONCE;
    if (usingInternalClipboard && clip && !clip.isCut && !destRef && pasteMayTile(pasteHeight, pasteWidth, selection)) {
      tiles = pasteTiles(pasteHeight, pasteWidth, selection, await selectionHoldsMergedCells(selection));
    }
    // The whole area the paste covers: the block, times its tiles.
    const fullHeight = pasteHeight * tiles.rows;
    const fullWidth = pasteWidth * tiles.cols;

    // A copied or cut block that would run past the SHEET's last row or column
    // is refused whole, as Excel refuses it [LIVE 2026-10-30,
    // clip4/probe-edge.ps1: A1:A3 copied and pasted at D1048575 -> "You can't
    // paste this here because the Copy area and paste area aren't the same
    // size"; Range("A1:A3").Cut Range("B1048575") -> "This selection isn't
    // valid", A1 untouched]. Pasting the part that fits and moving the whole
    // block used to clear (and announce as moved) cells that landed nowhere.
    // An object's cells keep the clamp below (a floating grid's own extent).
    if (!destRef && usingInternalClipboard && (targetRow + fullHeight > totalRows || targetCol + fullWidth > totalCols)) {
      void alertAsync(clip?.isCut ? MOVE_PAST_THE_EDGE : PASTE_PAST_THE_EDGE);
      return;
    }

    // Calculate actual paste bounds (clamped to grid bounds)
    const actualPasteHeight = Math.min(fullHeight, totalRows - targetRow);
    const actualPasteWidth = Math.min(fullWidth, totalCols - targetCol);

    // Check if paste target overlaps a protected range (e.g., pivot table).
    // The guards describe the ACTIVE sheet's regions; an object's cells are
    // gated by the backend on the object's own (backing) cells.
    const rangeGuard = destRef
      ? null
      : checkRangeGuards(
          targetRow, targetCol,
          targetRow + actualPasteHeight - 1, targetCol + actualPasteWidth - 1
        );
    if (rangeGuard?.blocked) {
      if (rangeGuard.message) void alertAsync(rangeGuard.message);
      return;
    }

    // Track if this was a cut operation (need to check before we potentially modify internalClipboard)
    const wasCutOperation = usingInternalClipboard && clip?.isCut === true;

    // A snapshot whose source may have changed and could NOT be read again
    // (the read failed -- size never stops it) would paste what the source no
    // longer holds: a cut would move it and lose the source's current value, a
    // copy would paste it silently. Excel pastes what is there now; when that
    // cannot be read, nothing is pasted and the mode ends (see CLIPBOARD MODE).
    if (usingInternalClipboard && snapshotIsUnreadable(clip)) {
      cutSourceRef.current = null;
      endClipboardMode();
      dispatch(clearClipboard());
      await alertAsync(
        wasCutOperation
          ? "The cut cells may have changed since they were cut, and what they hold now could not be read, so nothing was moved. Cut them again."
          : "The copied cells may have changed since they were copied, and what they hold now could not be read, so nothing was pasted. Copy them again.",
      );
      return;
    }

    // A SHEET cut: where its source sheet is NOW (cutSourceSheetNow), so the
    // source is cleared there and not on whatever sheet is active. A cut whose
    // sheet was deleted has nothing left to move: refused before anything is
    // written, and the cut is over (Excel ends cut mode when its sheet goes).
    let cutSource: CutSourceSheet | null = null;
    if (wasCutOperation && clip && !clip.sourceTarget) {
      cutSource = await cutSourceSheetNow(clip, {
        activeSheetIndex: sheetContext.activeSheetIndex,
        activeSheetId: sheetContext.activeSheetId,
      });
      if (cutSource === null) {
        cutSourceRef.current = null;
        endCutMode();
        dispatch(clearClipboard());
        await alertAsync(
          "The cells you cut were on a sheet that has since been deleted, so there is nothing to move. Nothing was pasted.",
        );
        return;
      }
    }
    // The cut came from a sheet other than the active one (a cut on Sheet1
    // pasted on Sheet2): a move BETWEEN sheets.
    const cutFromOtherSheet = cutSource !== null && !cutSource.isActive;

    // WHERE EACH WRITE'S SOURCE STANDS NOW (BUG-0657, `pasteSourceOf`): the
    // source sheet's index now (a cut's is `cutSource`), or an object's cells.
    // A snapshot whose positions were lost names no source -- it pastes what it
    // has (see STRUCTURAL CHANGES). Nothing else ever comes from outside this
    // workbook: File > New / Open ends the mode, and another program's text is
    // not the internal clipboard.
    let sourceSheetNow: number | null = null;
    if (usingInternalClipboard && clip && !positionsLostAtTake) {
      if (clip.sourceTarget) {
        // Not used with a target (an object's cells carry no sheet: their
        // ClipboardData.sourceSheetIndex is -1, which the wire's index refuses).
        sourceSheetNow = sheetContext.activeSheetIndex;
      } else if (cutSource) {
        sourceSheetNow = cutSource.index;
      } else {
        const where = await cutSourceSheetNow(clip, {
          activeSheetIndex: sheetContext.activeSheetIndex,
          activeSheetId: sheetContext.activeSheetId,
        });
        sourceSheetNow = where?.index ?? null;
      }
    }

    // Shift formulas for copy operations (not cut).
    // Copy adjusts relative references based on offset; cut moves cells as-is.
    const shiftedFormulaMap = new Map<string, string>();
    if (usingInternalClipboard && !wasCutOperation && clip) {
      const sourceSel = clip.sourceSelection;
      const sourceMinRow = Math.min(sourceSel.startRow, sourceSel.endRow);
      const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);
      // PER-ROW deltas: a copy that collapsed filter-hidden rows has no single
      // row offset — matrix row r came from sourceRows[r] and lands on
      // targetRow + r. For an ordinary (uncollapsed) copy every entry is the
      // same value, so this is identical to the old single-delta behaviour.
      const rowDeltas = pasteRowDeltas(
        clip.sourceRows,
        sourceMinRow,
        targetRow,
        pasteHeight
      );
      const colDelta = targetCol - sourceMinCol;

      // Keyed by the cell's offset in the WHOLE pasted area ("R,C"): a tiled
      // paste shifts each tile's formulas to where that tile lands (B1 =A1*2
      // into D1:D3 -> =C1*2, =C2*2, =C3*2 [LIVE]).
      const formulaEntries: { key: string; formula: string; rowDelta: number; colDelta: number }[] = [];
      for (let tr = 0; tr < tiles.rows; tr++) {
        for (let r = 0; r < pasteHeight; r++) {
          const rowDelta = rowDeltas[r] + tr * pasteHeight;
          for (let tc = 0; tc < tiles.cols; tc++) {
            const tileColDelta = colDelta + tc * pasteWidth;
            if (rowDelta === 0 && tileColDelta === 0) continue;
            for (let c = 0; c < pasteWidth; c++) {
              const cell = cellsToPaste![r]?.[c];
              if (cell?.formula) {
                formulaEntries.push({
                  key: `${tr * pasteHeight + r},${tc * pasteWidth + c}`,
                  formula: cell.formula,
                  rowDelta,
                  colDelta: tileColDelta,
                });
              }
            }
          }
        }
      }

      if (formulaEntries.length > 0) {
        const inputs: FormulaShiftInput[] = formulaEntries.map((e) => ({
          formula: e.formula,
          rowDelta: e.rowDelta,
          colDelta: e.colDelta,
        }));
        const shiftedFormulas = await shiftFormulasBatch(inputs);
        for (let i = 0; i < formulaEntries.length; i++) {
          shiftedFormulaMap.set(formulaEntries[i].key, shiftedFormulas[i]);
        }
      }
    }

    // THE SOURCE MUST STILL STAND WHERE THE PASTE NAMES IT as the write goes
    // out: a write onto the copied cells that lands now changes nothing here
    // (the backend reads the source at the write -- BUG-0657; this used to
    // restart the paste for every such write, and refuse a source that never
    // held still), but a copy that FOLLOWED a shift during the paste's awaits
    // names other cells now. Nothing is written yet, so the paste starts again
    // from the top, a bounded number of times; past the bound it pastes the
    // snapshot it has and names no source.
    let namesSources = sourceSheetNow !== null;
    if (usingInternalClipboard && clip && sourceMovedDuringPaste(clip, copyTaken, positionsLostAtTake)) {
      if (pasteRestarts < PASTE_SETTLE_ROUNDS) {
        pasteRestarts += 1;
        try {
          return await paste(args, ctx);
        } finally {
          pasteRestarts -= 1;
        }
      }
      namesSources = false;
    }

    // The paste's hold lives OUTSIDE the try, so every exit -- the outer catch
    // included -- can close the step the paste opened: anything that threw
    // after the write, the commit itself included, used to leave it OPEN, and
    // every later edit silently joined it (wave F, Z8).
    let tx: OwnedUndoTransaction | null = null;
    try {
      // Begin undo transaction so all paste changes are a single undo entry
      const transactionDesc = wasCutOperation
        ? `Cut and paste ${pasteHeight * pasteWidth} cells`
        : `Paste ${fullHeight * fullWidth} cells`;
      tx = ownUndoTransaction(await beginUndoTransaction(transactionDesc), UNDO_CLOSES);

      // A CUT moves all or nothing (A CUT'S PASTE IS ALL OR NOTHING): the
      // point to take it back to is marked before anything is written, and a
      // cut whose step cannot carry one is refused here -- the cut stays
      // pending, since nothing about its source refused it.
      let movePoint: UndoSavepoint | null = null;
      if (wasCutOperation) {
        const marked = await markMovePoint(transactionDesc);
        if (marked.point === null) {
          await tx.cancel().catch(() => {});
          void alertAsync(
            `The cut cells were not moved: a move is taken back whole when it cannot finish, ` +
              `and that could not be arranged right now (${marked.why}). Nothing was pasted.`,
          );
          return;
        }
        movePoint = marked.point;
      }

      // Build batch updates array (single IPC call instead of one per cell)
      const perfPasteStart = performance.now();
      const batchUpdates: CellUpdateInput[] = [];
      // The internal clipboard's STORED values (absent: a copy that could not
      // read them typed, or text from another program).
      const storedValues = usingInternalClipboard ? clip?.values : undefined;

      // Every cell of the pasted area, the block repeated over its tiles:
      // (R, C) in the area is the block's (R mod height, C mod width).
      for (let R = 0; R < fullHeight; R++) {
        const r = R % pasteHeight;
        for (let C = 0; C < fullWidth; C++) {
          const c = C % pasteWidth;
          const destRow = targetRow + R;
          const destCol = targetCol + C;

          // Check bounds
          if (destRow >= totalRows || destCol >= totalCols) {
            continue;
          }

          const sourceCell = cellsToPaste[r]?.[c];
          const formula = shiftedFormulaMap.get(`${R},${C}`) ?? sourceCell?.formula ?? null;

          const update: CellUpdateInput = { row: destRow, col: destCol, value: formula ?? sourceCell?.display ?? "" };

          // Include style index when pasting from internal clipboard
          if (usingInternalClipboard) {
            update.styleIndex = sourceCell?.styleIndex ?? 0;
            // A CUT's paste MOVES the cell, format included: on a protected
            // sheet without Format Cells the batch still writes this style
            // (a copy's is dropped), as Excel moves it (CellUpdateInput.moved).
            // The claim names the SOURCE cell, and the backend honours it only
            // when that cell shows this style (round 18: bound, not asserted).
            // A cut out of an OBJECT (a floating grid's cells) names the
            // object (`target`), whose own coordinates the source rows are.
            if (wasCutOperation && clip && (cutSource || clip.sourceTarget)) {
              const sourceRow = clip.sourceRows[r];
              if (sourceRow !== undefined) {
                update.moved = {
                  sheetIndex: cutSource ? cutSource.index : sheetContext.activeSheetIndex,
                  row: sourceRow,
                  col: Math.min(clip.sourceSelection.startCol, clip.sourceSelection.endCol) + c,
                  ...(clip.sourceTarget ? { target: clip.sourceTarget } : {}),
                };
              }
            }
            // ...and what it is written FROM (BUG-0657): the backend writes
            // what that cell holds at the write -- a copy's formula shifted to
            // here (a tile's by its own offset), a cut's as it stands, a
            // constant as its stored value -- and `value` below is only the
            // fallback. The format still comes from the snapshot.
            if (namesSources && clip && sourceSheetNow !== null) {
              const sourceRow = clip.sourceRows[r];
              if (sourceRow !== undefined) {
                update.source = pasteSourceOf(
                  sourceSheetNow,
                  sourceRow,
                  Math.min(clip.sourceSelection.startCol, clip.sourceSelection.endCol) + c,
                  { target: clip.sourceTarget, move: wasCutOperation },
                );
              }
            }
            if (formula) {
              // A PASTE, not an entry: the formula stays one even under a
              // Text-formatted (@) source style (CellUpdateInput.pasted).
              update.pasted = true;
            } else if (storedValues) {
              // A CONSTANT is written from its stored value, invariant -- never
              // by re-typing the display text, which held only what the
              // source's number format showed (1.23456 under 0.00 pasted as
              // 1.23). Excel pastes the value (clipboardValues.ts), and a
              // number keeps its kind under an @ style: Excel pastes the 5
              // from an @ cell as the number 5, keeping the @.
              const constant = pastedConstantInput(storedValues[r]?.[c], sourceCell?.display ?? "");
              if (constant) {
                update.value = constant.value;
                update.invariant = true;
                update.pasted = true;
              }
            }
          }

          batchUpdates.push(update);
        }
      }

      // ...AND AT THE WRITE: the check above runs before the step opens, and a
      // copy that followed a shift while it opened (beginUndoTransaction, a
      // cut's markMovePoint) names other cells now. Checked again here, with no
      // await left before the batch goes out: nothing is written yet, so the
      // step is closed empty and the paste starts again from the top (bounded,
      // as above); past the bound the writes name no source.
      if (usingInternalClipboard && clip && namesSources && sourceMovedDuringPaste(clip, copyTaken, positionsLostAtTake)) {
        if (pasteRestarts < PASTE_SETTLE_ROUNDS) {
          await tx.cancel().catch(() => {});
          pasteRestarts += 1;
          try {
            return await paste(args, ctx);
          } finally {
            pasteRestarts -= 1;
          }
        }
        for (const update of batchUpdates) delete update.source;
      }

      // A CUT ON ONE SHEET empties the DATA-TABLE BODY cells it vacates IN
      // THIS BATCH (NEW-clear-cell-datatable-gate). A whole data table the cut
      // moves is then gone from its old place the moment it lands in its new
      // one: moved onto part of its own body (one row up, one column left),
      // the tail of its old body used to stand beside the moved body with the
      // same `TABLE(..)` call -- one table to the gate -- and the per-cell
      // clear below, which Excel's rule refuses on part of a table ("Can't
      // change part of a data table."), could not take it; moved anywhere
      // else, the per-cell clear met the whole old body one cell at a time.
      // The batch's gate judges these writes with the move (a table the cut
      // moves only part of is refused there). The clear below still takes
      // each vacated cell's format.
      if (
        wasCutOperation &&
        usingInternalClipboard &&
        clip &&
        cutSourceRef.current &&
        !cutFromOtherSheet &&
        !clip.sourceTarget &&
        !destRef &&
        cellsToPaste
      ) {
        const srcMinCol = Math.min(clip.sourceSelection.startCol, clip.sourceSelection.endCol);
        for (let r = 0; r < pasteHeight; r++) {
          const sourceRow = clip.sourceRows[r];
          if (sourceRow === undefined) continue;
          for (let c = 0; c < pasteWidth; c++) {
            const cell = cellsToPaste[r]?.[c];
            const sourceCol = srcMinCol + c;
            if (isDataTableFormula(cell?.formula) && !inRect(sourceRow, sourceCol, targetRow, targetCol, targetRow + pasteHeight - 1, targetCol + pasteWidth - 1)) {
              batchUpdates.push({ row: sourceRow, col: sourceCol, value: "" });
            }
          }
        }
      }

      // Single batch IPC call for all cells
      try {
        if (destRef) await updateCellsBatch(batchUpdates, { target: destRef });
        else await updateCellsBatch(batchUpdates);
      } catch (err) {
        // Close the transaction opened above — a rejected paste (e.g. into a
        // protected pivot/report region) must not leave it dangling, or the
        // user's NEXT edits would silently merge into one undo entry.
        await tx.cancel().catch(() => {});
        const msg = typeof err === "string" ? err : (err as Error)?.message || String(err);
        void alertAsync(msg);
        return;
      }

      const perfPasteEnd = performance.now();
      console.log(
        `[PERF][paste] ${batchUpdates.length} cells | ` +
        `batch IPC=${(perfPasteEnd - perfPasteStart).toFixed(1)}ms`
      );

      // The block a cut moved, for CELLS_MOVED after the commit (see below).
      let movedBlock: [number, number, number, number, number, number, number, number] | null = null;

      // If this was a cut operation, clear the source cells
      if (wasCutOperation && cutSourceRef.current) {
        const src = cutSourceRef.current;
        const srcMinRow = Math.min(src.startRow, src.endRow);
        const srcMaxRow = Math.max(src.startRow, src.endRow);
        const srcMinCol = Math.min(src.startCol, src.endCol);
        const srcMaxCol = Math.max(src.startCol, src.endCol);
        const srcRef = clip?.sourceTarget;

        // ALL OR NOTHING (A CUT'S PASTE IS ALL OR NOTHING): the FIRST refusal
        // of the source's clear, or of the relocation that makes it a move,
        // stops the work here, and the whole paste is taken back below. The
        // clears used to swallow a refusal cell by cell and carry on.
        let moveRefusal: string | null = null;
        // A SHEET block moved between sheet cells (never an object's): what
        // CELLS_MOVED announces once the step has committed.
        const movedFromSheet: number | null =
          srcRef || destRef ? null : cutFromOtherSheet && cutSource ? cutSource.index : sheetContext.activeSheetIndex;
        try {
          if (cutFromOtherSheet && cutSource) {
            // A SHEET cut pasted on ANOTHER sheet -- its cells, or a floating
            // grid's (destRef) -- is a move between sheets (Excel [LIVE]): the
            // source is cleared, value and format, on ITS OWN sheet, by ONE
            // sheet-addressed clear inside this step. Two sheets cannot overlap.
            // The per-cell `clearCell` this used to fall into acts on the ACTIVE
            // sheet: it erased the destination sheet's cells at the source's
            // addresses and left the source where it was.
            await clearRangeWithOptions(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol, "all", cutSource.index);
            // The references to the cut cells -- on every sheet and in defined
            // names -- follow them to this sheet (`=A1` on the source sheet
            // becomes `=Sheet2!D4`), and the moved formulas keep naming the
            // source sheet's cells they read (`=B5` becomes `=Sheet1!B5`).
            // Never into an object: the relocation re-points to the ACTIVE
            // sheet's coordinates.
            if (!destRef) {
              await relocateCellReferences(
                srcMinRow, srcMinCol, srcMaxRow, srcMaxCol, targetRow, targetCol, cutSource.index,
              );
            }
          } else if (srcRef || destRef) {
            // An OBJECT on either side (P3). Source and destination overlap only
            // when they are the SAME place -- the same object -- never by raw
            // coordinates: Float1!B2 and the host's B2 are different cells, and
            // reading them as one skipped the source clear and silently turned
            // the cut into a copy.
            const samePlace = sameTarget(srcRef, destRef);
            const overlaps = (r: number, c: number) =>
              samePlace &&
              r >= targetRow &&
              r < targetRow + pasteHeight &&
              c >= targetCol &&
              c < targetCol + pasteWidth;
            if (srcRef && !samePlace) {
              // A different place cannot overlap: ONE clear over the whole source
              // rectangle, through the source's own target, inside this step.
              await clearRangeWithOptions(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol, "all", undefined, {
                target: srcRef,
              });
            } else {
              for (let r = srcMinRow; r <= srcMaxRow; r++) {
                for (let c = srcMinCol; c <= srcMaxCol; c++) {
                  if (overlaps(r, c)) continue;
                  if (srcRef) await clearRangeWithOptions(r, c, r, c, "all", undefined, { target: srcRef });
                  else await clearCell(r, c);
                }
              }
            }
          } else {
            for (let r = srcMinRow; r <= srcMaxRow; r++) {
              for (let c = srcMinCol; c <= srcMaxCol; c++) {
                // Don't clear if it overlaps with paste destination
                const overlaps =
                  r >= targetRow &&
                  r < targetRow + pasteHeight &&
                  c >= targetCol &&
                  c < targetCol + pasteWidth;
                if (!overlaps) await clearCell(r, c);
              }
            }

            // A Cut + Paste is a MOVE (Excel's Range.Cut Destination): every
            // reference INTO the cut cells -- in the pasted formulas themselves,
            // elsewhere on this sheet, on other sheets, in defined names -- now
            // names where they landed, a reference to a cell the paste
            // overwrote is #REF!, and every other reference is left alone (the
            // pasted formulas were written unshifted). Without this a formula
            // reading a cut cell kept naming the emptied source. This branch is
            // the SAME sheet (cutFromOtherSheet took the move between sheets).
            await relocateCellReferences(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol, targetRow, targetCol);
          }
        } catch (err) {
          console.error("[Clipboard] The cut cells could not be moved:", err);
          moveRefusal = errorText(err);
        }

        if (moveRefusal !== null) {
          // Taken back to the point marked before the write: the destination
          // and any part of the source already cleared are as they were. The
          // cut is over either way -- its source refused the move.
          const notTakenBack = movePoint ? await takeBackRefusedMove(movePoint) : "no point was marked";
          cutSourceRef.current = null;
          endCutMode();
          dispatch(clearClipboard());
          if (notTakenBack === null) {
            // The step holds nothing of the paste's any more: closed empty.
            await tx.cancel().catch(() => {});
            void alertAsync(`The cut cells could not be moved, so nothing was pasted. ${moveRefusal}`);
          } else {
            // The take-back itself failed: the paste stays ONE undo step, so
            // Undo takes it back, and the user is told exactly what is left.
            await tx.commit();
            void alertAsync(
              `The cells were pasted, but they could not be removed from where they were cut ` +
                `(${moveRefusal}), and the paste could not be taken back (${notTakenBack}). ` +
                `Undo takes the paste back.`,
            );
          }
          window.dispatchEvent(new CustomEvent("grid:refresh"));
          window.dispatchEvent(new CustomEvent("styles:refresh"));
          return;
        }

        // Clear cut source reference
        cutSourceRef.current = null;
        // A cut is one-time, and its paste ENDS cut mode the way Excel's does
        // [LIVE]: the clipboard is emptied and a second Paste pastes nothing --
        // it used to paste the moved snapshot again, as a copy.
        endCutMode();

        // Clear clipboard visual state only after cut+paste (cut is one-time operation)
        dispatch(clearClipboard());
        console.log("[Clipboard] Cut+paste complete, clipboard cleared");
        movedBlock =
          movedFromSheet === null
            ? null
            : [movedFromSheet, srcMinRow, srcMinCol, srcMaxRow, srcMaxCol, sheetContext.activeSheetIndex, targetRow, targetCol];
      } else {
        // Copy+paste: keep clipboard active for multiple pastes
        console.log("[Clipboard] Copy+paste complete, clipboard remains active");
      }

      // Commit the undo transaction
      await tx.commit();
      pastesLanded++;
      // The cut cells MOVED: the stores that follow cells follow them
      // (CELLS_MOVED), once the move is one committed step.
      // Joined: tagged with the outer step's transaction (the move point names
      // it), so only that step's take-back or close touches the memory.
      if (movedBlock) announceCellsMoved(...movedBlock, tx?.opened === false ? (movePoint?.transaction ?? true) : false);

      // Refresh grid after paste (single viewport refresh for all pasted cells)
      window.dispatchEvent(new CustomEvent("grid:refresh"));
      if (usingInternalClipboard) {
        window.dispatchEvent(new CustomEvent("styles:refresh"));
      }

      // Update selection to cover the pasted range
      const pastedEndRow = targetRow + actualPasteHeight - 1;
      const pastedEndCol = targetCol + actualPasteWidth - 1;

      if (owned) {
        // The OBJECT's own selection (Core's is hidden under the object).
        selectTargetCells(owned, {
          startRow: targetRow,
          startCol: targetCol,
          endRow: pastedEndRow,
          endCol: pastedEndCol,
          type: "cells",
        });
      } else {
        dispatch(setSelection({
          startRow: targetRow,
          startCol: targetCol,
          endRow: pastedEndRow,
          endCol: pastedEndCol,
        }));
      }
      
      console.log("[Clipboard] Selection moved to pasted range:", {
        startRow: targetRow,
        startCol: targetCol,
        endRow: pastedEndRow,
        endCol: pastedEndCol,
      });
    } catch (error) {
      console.error("[Clipboard] Paste failed:", error);
      // Close what THIS paste opened (a no-op after a commit that landed, or
      // after a join -- a script's batch is its holder's to close).
      await tx?.cancel().catch(() => {});
    }
  }, [coreSelection, config.totalRows, config.totalCols, dispatch, sheetContext.activeSheetIndex, sheetContext.activeSheetId]);

  /**
   * Check if there's clipboard data available.
   */
  const hasClipboardData = useCallback((): boolean => {
    return internalClipboard !== null;
  }, []);

  /**
   * Clear clipboard state (removes marching ants visual).
   * Called when user presses ESC.
   */
  const clearClipboardState = useCallback(() => {
    console.log("[Clipboard] Clearing clipboard state (ESC pressed)");
    dispatch(clearClipboard());
    // Esc ENDS the clipboard mode, a COPY's as well as a cut's: the next Paste
    // pastes nothing and the system clipboard is emptied, as in Excel [LIVE,
    // clipexcel/probe-copy.ps1: after Ctrl+C and Esc, CutCopyMode is 0, the
    // Paste button is disabled, the clipboard holds nothing and
    // Worksheet.Paste fails] (see CLIPBOARD MODE; BUG-0616 item 5 -- a copy
    // used to stay pasteable after Esc).
    endClipboardMode();
  }, [dispatch]);

  /**
   * Move cells from source selection to a new position.
   * This moves the cell data (not a structural reorder).
   */
  const moveCells = useCallback(
    async (source: Selection, targetRow: number, targetCol: number): Promise<void> => {
      console.log("[Clipboard] Moving cells from", source, "to", targetRow, targetCol);

      // Normalize source bounds
      const srcMinRow = Math.min(source.startRow, source.endRow);
      const srcMaxRow = Math.max(source.startRow, source.endRow);
      const srcMinCol = Math.min(source.startCol, source.endCol);
      const srcMaxCol = Math.max(source.startCol, source.endCol);

      const height = srcMaxRow - srcMinRow + 1;
      const width = srcMaxCol - srcMinCol + 1;

      const destEndRow = targetRow + height - 1;
      const destEndCol = targetCol + width - 1;

      // Detect if source contains a protected region (e.g., pivot table).
      // Test sample points — if any single cell is blocked, there's a protected region.
      const hasPivotInSource = (() => {
        const testPoints = [
          [srcMinRow, srcMinCol], [srcMinRow, srcMaxCol],
          [srcMaxRow, srcMinCol], [srcMaxRow, srcMaxCol],
          [Math.floor((srcMinRow + srcMaxRow) / 2), Math.floor((srcMinCol + srcMaxCol) / 2)],
        ];
        for (const [r, c] of testPoints) {
          const g = checkRangeGuards(r, c, r, c);
          if (g?.blocked) return true;
        }
        return false;
      })();

      if (hasPivotInSource) {
        // Delegate to extensions — emit event and update selection, skip cell-by-cell move.
        // The extension (e.g., Pivot) handles clearing old cells and writing new ones.
        console.log("[Clipboard] Source contains protected region, delegating move to extensions");

        window.dispatchEvent(new CustomEvent("cells:moved", {
          detail: {
            sourceStartRow: srcMinRow, sourceStartCol: srcMinCol,
            sourceEndRow: srcMaxRow, sourceEndCol: srcMaxCol,
            targetRow, targetCol,
          }
        }));

        dispatch(setSelection({
          startRow: targetRow,
          startCol: targetCol,
          endRow: targetRow + height - 1,
          endCol: targetCol + width - 1,
          type: source.type,
        }));
        return;
      }

      // Check if destination overlaps a protected range (e.g., pivot table)
      const destGuard = checkRangeGuards(targetRow, targetCol, destEndRow, destEndCol);
      if (destGuard?.blocked) {
        if (destGuard.message) void alertAsync(destGuard.message);
        return;
      }

      // Also check if source overlaps a protected range
      const srcGuard = checkRangeGuards(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol);
      if (srcGuard?.blocked) {
        if (srcGuard.message) void alertAsync(srcGuard.message);
        return;
      }

      // A block that would land past the sheet's last row or column is refused
      // whole, as Excel refuses moving it there [LIVE 2026-10-30: Range("A1:A3")
      // .Cut Range("B1048575") -> "This selection isn't valid", nothing moved].
      // The part that fit used to be written, the WHOLE source cleared, and the
      // whole block announced as moved -- the overhanging cells were lost.
      if (destEndRow >= config.totalRows || destEndCol >= config.totalCols) {
        void alertAsync(MOVE_PAST_THE_EDGE);
        return;
      }

      // Check if destination area has content (excluding source overlap) and confirm
      const hasContent = await hasContentInRange(targetRow, targetCol, destEndRow, destEndCol);
      if (hasContent) {
        const confirmed = await confirmAsync(
          "There is data in the destination area. Do you want to replace it?",
          { title: "Calcula", kind: "warning", okLabel: "Yes", cancelLabel: "No" }
        );
        if (!confirmed) return;
      }

      let tx: OwnedUndoTransaction | null = null;
      try {
        // Begin undo transaction for the entire move operation
        const moveDesc = `Move ${height * width} cells`;
        tx = ownUndoTransaction(await beginUndoTransaction(moveDesc), UNDO_CLOSES);

        // A MOVE IS ALL OR NOTHING, as a cut's paste is (A CUT'S PASTE IS ALL OR
        // NOTHING): the point to take it back to is marked before anything is
        // written, and the FIRST refusal -- a destination write, the source's
        // clear, or the relocation that makes it a move -- takes every change
        // back to it, announces nothing and says why. The drag used to cancel a
        // refused write (which KEEPS the writes, with no undo step), swallow a
        // refused clear or relocation, commit, and announce the move anyway.
        const marked = await markMovePoint(moveDesc);
        if (marked.point === null) {
          await tx.cancel().catch(() => {});
          void alertAsync(
            `The cells were not moved: a move is taken back whole when it cannot finish, ` +
              `and that could not be arranged right now (${marked.why}). Nothing was changed.`,
          );
          return;
        }
        const movePoint = marked.point;
        const refuseMove = async (why: string): Promise<void> => {
          const notTakenBack = await takeBackRefusedMove(movePoint);
          if (notTakenBack === null) {
            await tx?.cancel().catch(() => {});
            void alertAsync(`The cells could not be moved, so nothing was changed. ${why}`);
          } else {
            // The take-back itself failed: what ran stays ONE undo step, so
            // Undo takes it back, and the user is told exactly what is left.
            await tx?.commit().catch(() => {});
            void alertAsync(
              `The cells could not be moved (${why}), and what was already changed could not be ` +
                `taken back (${notTakenBack}). Undo takes it back.`,
            );
          }
          window.dispatchEvent(new CustomEvent("grid:refresh"));
          window.dispatchEvent(new CustomEvent("styles:refresh"));
        };

        // 1. Read source cells
        const sourceCells = await getViewportCells(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol);
        console.log("[Clipboard] Read", sourceCells.length, "source cells");
        // ...and their STORED values: a moved constant is written from these.
        const stored = await storedValuesOf(sourceCells);

        // 2. Build a map of source cells for quick lookup
        const cellMap = new Map<string, CellData>();
        for (const cell of sourceCells) {
          cellMap.set(`${cell.row},${cell.col}`, cell);
        }

        // 2b. A MOVED formula is written UNSHIFTED. Excel's move keeps every
        // reference to a cell OUTSIDE the moved block (=A1 moved from B1 to B2
        // stays =A1, measured live) and re-points only the references INTO
        // it, which relocateCellReferences (4b) does for these formulas as
        // for every other one. Shifting them here moved the outside
        // references too: =A1 became =A2.

        // 3. Write the destination in ONE batch (NEW-drag-move-whole-table),
        // as a Cut + Paste writes it: every write carries its MOVE claim and
        // names its SOURCE (BUG-0657), written as it stands at the write, its
        // formula unshifted. The backend reads every source under the batch's
        // guards BEFORE any write lands, so a source inside the destination is
        // named too. The claims are what let a WHOLE data table move with the
        // block (`data_tables::whole_table_moves`), as Excel moves it with Cut +
        // Paste [LIVE, dtfollow/probe1.ps1]; written one cell at a time, the
        // table's `=TABLE(..)` marker was refused as a typed formula ("That
        // function isn't valid."). The data-table BODY cells the block vacates
        // are emptied in the same batch, so the clear below (which Excel's rule
        // refuses on part of a table) never meets an old body -- nor, for a
        // table moved onto part of its own body, a tail of it standing beside
        // the moved body as one table (see `paste`).
        const destMinRow = targetRow;
        const destMaxRow = targetRow + height - 1;
        const destMinCol = targetCol;
        const destMaxCol = targetCol + width - 1;
        const updates: CellUpdateInput[] = [];
        const styles: Array<{ row: number; col: number; styleIndex: number }> = [];
        for (let r = 0; r < height; r++) {
          for (let c = 0; c < width; c++) {
            const srcRow = srcMinRow + r;
            const srcCol = srcMinCol + c;
            const destRow = targetRow + r;
            const destCol = targetCol + c;

            // Check bounds
            if (destRow >= config.totalRows || destCol >= config.totalCols) {
              continue;
            }

            const sourceCell = cellMap.get(`${srcRow},${srcCol}`);
            // A formula or a constant's stored value is a PASTE (it keeps its
            // kind in an @ destination); only a display-text fallback is an
            // entry the user-input parser reads.
            const input = movedCellInput(sourceCell, sourceCell?.formula, stored);
            updates.push({
              row: destRow,
              col: destCol,
              ...input,
              moved: moveClaimOf(sheetContext.activeSheetIndex, srcRow, srcCol),
              source: pasteSourceOf(sheetContext.activeSheetIndex, srcRow, srcCol, { move: true }),
            });
            styles.push({ row: destRow, col: destCol, styleIndex: sourceCell?.styleIndex ?? 0 });
          }
        }
        for (const cell of sourceCells) {
          if (isDataTableFormula(cell.formula) && !inRect(cell.row, cell.col, destMinRow, destMinCol, destMaxRow, destMaxCol)) {
            updates.push({ row: cell.row, col: cell.col, value: "" });
          }
        }

        try {
          const updatedCells = await updateCellsBatch(updates);
          // Copy style from source cell
          for (const { row, col, styleIndex } of styles) {
            await setCellStyle(row, col, styleIndex);
          }
          for (const cell of updatedCells) {
            if (cell.sheetIndex !== undefined) continue;
            cellEvents.emit({
              row: cell.row,
              col: cell.col,
              oldValue: undefined,
              newValue: cell.display,
              formula: cell.formula ?? null,
            }, "paste");
          }
        } catch (err) {
          const msg = typeof err === "string" ? err : (err as Error)?.message || String(err);
          // TAKEN BACK, never committed: committing here would record a
          // half-finished gesture, and a cancel drops the undo record and KEEPS
          // what was written. Everything goes back to the point marked above.
          //
          // Load-bearing: the batch can be refused by sheet protection or a
          // data table the block holds only part of, so this path is routine.
          await refuseMove(msg);
          return;
        }

        // 4. Clear source cells (excluding overlap with destination): their
        // values are gone already (the batch above), and this takes the rest
        // of each cell -- its format -- as a move does.

        for (let r = srcMinRow; r <= srcMaxRow; r++) {
          for (let c = srcMinCol; c <= srcMaxCol; c++) {
            // Check if this source cell overlaps with destination
            const overlaps =
              r >= destMinRow && r <= destMaxRow &&
              c >= destMinCol && c <= destMaxCol;

            if (!overlaps) {
              try {
                await clearCell(r, c);
                cellEvents.emit({
                  row: r,
                  col: c,
                  oldValue: undefined,
                  newValue: "",
                  formula: null,
                }, "paste");
              } catch (err) {
                // A source cell that cannot be cleared: the move cannot finish.
                console.error(`[Clipboard] Failed to clear source (${r}, ${c}):`, err);
                await refuseMove(errorText(err));
                return;
              }
            }
          }
        }

        // 4b. Relocate formula references: every reference INTO the source
        // range -- in the moved formulas themselves, anywhere on this sheet,
        // on other sheets and in defined names -- now names the destination.
        // A refused relocation takes the whole move back: committed, it left
        // the formulas naming the emptied source, and when the refusal came
        // before the step recorded the move, its Undo left every watch and
        // bookmark on the drop target.
        try {
          const relocated = await relocateCellReferences(
            srcMinRow, srcMinCol, srcMaxRow, srcMaxCol,
            targetRow, targetCol,
          );
          for (const cell of relocated) {
            cellEvents.emit({
              row: cell.row,
              col: cell.col,
              oldValue: undefined,
              newValue: cell.display,
              formula: cell.formula ?? null,
            }, "paste");
          }
          if (relocated.length > 0) {
            console.log(`[Clipboard] Relocated references in ${relocated.length} formulas`);
          }
        } catch (err) {
          console.error("[Clipboard] Failed to relocate cell references:", err);
          await refuseMove(errorText(err));
          return;
        }

        // Commit the undo transaction
        await tx.commit();

        // Refresh style cache so the canvas picks up styles from moved cells
        window.dispatchEvent(new CustomEvent("styles:refresh"));
        window.dispatchEvent(new CustomEvent("grid:refresh"));

        // Notify extensions that cells were moved (e.g., pivot relocation)
        window.dispatchEvent(new CustomEvent("cells:moved", {
          detail: {
            sourceStartRow: srcMinRow, sourceStartCol: srcMinCol,
            sourceEndRow: srcMaxRow, sourceEndCol: srcMaxCol,
            targetRow, targetCol,
          }
        }));
        // ...and the stores that follow cells (a watch, a bookmark) follow the
        // dragged block, as they follow a Cut + Paste.
        announceCellsMoved(
          sheetContext.activeSheetIndex, srcMinRow, srcMinCol, srcMaxRow, srcMaxCol,
          sheetContext.activeSheetIndex, targetRow, targetCol, tx?.opened === false ? movePoint.transaction : false,
        );

        // 5. Update selection to new position
        dispatch(setSelection({
          startRow: targetRow,
          startCol: targetCol,
          endRow: targetRow + height - 1,
          endCol: targetCol + width - 1,
          type: source.type,
        }));

        console.log("[Clipboard] Move cells complete");
      } catch (error) {
        console.error("[Clipboard] Move cells failed:", error);
        await tx?.cancel().catch(() => {});
        void alertAsync(typeof error === "string" ? error : (error as Error)?.message || String(error));
      }
    },
    [config.totalRows, config.totalCols, dispatch, sheetContext.activeSheetIndex]
  );

  /**
   * Move rows from source position to target position (overwrite, not structural shift).
   * Source rows are cleared, target rows are replaced with source data.
   */
  const moveRows = useCallback(
    async (sourceStartRow: number, sourceEndRow: number, targetRow: number): Promise<void> => {
      console.log("[Clipboard] Moving rows", sourceStartRow, "-", sourceEndRow, "to", targetRow);

      const minRow = Math.min(sourceStartRow, sourceEndRow);
      const maxRow = Math.max(sourceStartRow, sourceEndRow);
      const count = maxRow - minRow + 1;

      // Don't move if target is within source range
      if (targetRow >= minRow && targetRow <= maxRow) {
        console.log("[Clipboard] Target is within source range, no-op");
        return;
      }

      // Check if source or destination rows overlap a protected range
      const targetEndRow = targetRow + count - 1;
      const srcRowGuard = checkRangeGuards(minRow, 0, maxRow, config.totalCols - 1);
      if (srcRowGuard?.blocked) { if (srcRowGuard.message) void alertAsync(srcRowGuard.message); return; }
      const destRowGuard = checkRangeGuards(targetRow, 0, targetEndRow, config.totalCols - 1);
      if (destRowGuard?.blocked) { if (destRowGuard.message) void alertAsync(destRowGuard.message); return; }

      const hasContent = await hasContentInRange(targetRow, 0, targetEndRow, config.totalCols - 1);
      if (hasContent) {
        const confirmed = await confirmAsync(
          "There is data in the destination area. Do you want to replace it?",
          { title: "Calcula", kind: "warning", okLabel: "Yes", cancelLabel: "No" }
        );
        if (!confirmed) return;
      }

      let tx: OwnedUndoTransaction | null = null;
      try {
        tx = ownUndoTransaction(await beginUndoTransaction(`Move ${count} rows`), UNDO_CLOSES);

        // 1. Read all cell data from source rows (sparse), and their STORED
        // values: a moved constant is written from these.
        const sourceCells = await getCellsInRows(minRow, maxRow);
        console.log("[Clipboard] Read", sourceCells.length, "cells from source rows");
        const stored = await storedValuesOf(sourceCells);

        // 2. Clear target rows
        await clearRange(targetRow, 0, targetEndRow, config.totalCols - 1);

        // 2b. A MOVED formula is written UNSHIFTED; relocateCellReferences
        // (4b) re-points its references INTO the moved rows and leaves the
        // rest, as Excel's move does (see moveCells).

        // 3. Write source data to target rows
        // Each write names the SOURCE it moves (BUG-0657), written as it
        // stands at the write -- except a source in the target rows, which the
        // clear above has just emptied -- and carries its MOVE claim, as a Cut
        // + Paste's writes do, so a WHOLE data table in the rows moves with
        // them (`data_tables::whole_table_moves`, NEW-drag-move-whole-table).
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newRow = targetRow + (cell.row - minRow);
          const input = movedCellInput(cell, cell.formula, stored);
          if (input.value) {
            const stands = cell.row < targetRow || cell.row > targetEndRow;
            const named = input.pasted && stands;
            updates.push({
              row: newRow,
              col: cell.col,
              ...input,
              ...(named ? { source: pasteSourceOf(sheetContext.activeSheetIndex, cell.row, cell.col, { move: true }) } : {}),
              ...(stands ? { moved: moveClaimOf(sheetContext.activeSheetIndex, cell.row, cell.col) } : {}),
            });
          }
        }
        if (updates.length > 0) {
          await updateCellsBatch(updates);
        }

        // 3b. Copy styles from source cells to target rows
        for (const cell of sourceCells) {
          if (cell.styleIndex > 0) {
            const newRow = targetRow + (cell.row - minRow);
            await setCellStyle(newRow, cell.col, cell.styleIndex);
          }
        }

        // 4. Clear source rows (excluding overlap with target)
        const srcOverlapsTarget =
          minRow <= targetEndRow && maxRow >= targetRow;
        if (srcOverlapsTarget) {
          if (minRow < targetRow) {
            await clearRange(minRow, 0, targetRow - 1, config.totalCols - 1);
          }
          if (maxRow > targetEndRow) {
            await clearRange(targetEndRow + 1, 0, maxRow, config.totalCols - 1);
          }
        } else {
          await clearRange(minRow, 0, maxRow, config.totalCols - 1);
        }

        // 4b. Relocate every reference INTO the moved rows (the moved formulas'
        // own included -- they were written unshifted). The step records the
        // rows as a MOVED block, like a Cut + Paste's: a drag of whole rows
        // OVERWRITES the rows it lands on, and the rows it passes over stay
        // where they are [LIVE 2026-10-30, Range("3:4").Cut Range("A10"):
        // watches on C3/C4 read C10/C11, the one on C6 stays, the ones on
        // C10/C11 are removed, =C10 becomes #REF!].
        // A refused relocation records no move, so nothing announces one: the
        // followers stay where the references stayed.
        let relocated = false;
        try {
          await relocateCellReferences(
            minRow, 0, maxRow, config.totalCols - 1,
            targetRow, 0,
          );
          relocated = true;
        } catch (err) {
          console.error("[Clipboard] Failed to relocate cell references:", err);
        }

        await tx.commit();
        // The stores that follow cells (a watch, a bookmark) follow the rows --
        // only when the step recorded them as moved.
        if (relocated) {
          announceCellsMoved(
            sheetContext.activeSheetIndex, minRow, 0, maxRow, config.totalCols - 1,
            sheetContext.activeSheetIndex, targetRow, 0, tx?.opened === false,
          );
        }

        // 5. Emit change event to trigger grid refresh
        cellEvents.emit({
          row: -1,
          col: -1,
          oldValue: undefined,
          newValue: "structure_change",
          formula: null,
        }, "paste");

        // 6. Update selection to new position
        dispatch(setSelection({
          startRow: targetRow,
          startCol: 0,
          endRow: targetEndRow,
          endCol: config.totalCols - 1,
          type: "rows",
        }));

        console.log("[Clipboard] Move rows complete");
      } catch (error) {
        // Close the "Move N rows" transaction — left open, every subsequent
        // edit silently joins it and collapses into one Ctrl+Z step.
        await tx?.cancel().catch(() => {});
        const msg = typeof error === "string" ? error : (error as Error)?.message || String(error);
        void alertAsync(msg);
      }
    },
    [config.totalCols, dispatch, sheetContext.activeSheetIndex]
  );

  /**
   * Move columns from source position to target position (overwrite, not structural shift).
   * Source columns are cleared, target columns are replaced with source data.
   */
  const moveColumns = useCallback(
    async (sourceStartCol: number, sourceEndCol: number, targetCol: number): Promise<void> => {
      console.log("[Clipboard] Moving columns", sourceStartCol, "-", sourceEndCol, "to", targetCol);

      const minCol = Math.min(sourceStartCol, sourceEndCol);
      const maxCol = Math.max(sourceStartCol, sourceEndCol);
      const count = maxCol - minCol + 1;

      // Don't move if target is within source range
      if (targetCol >= minCol && targetCol <= maxCol) {
        console.log("[Clipboard] Target is within source range, no-op");
        return;
      }

      // Check if source or destination columns overlap a protected range
      const targetEndCol = targetCol + count - 1;
      const srcColGuard = checkRangeGuards(0, minCol, config.totalRows - 1, maxCol);
      if (srcColGuard?.blocked) { if (srcColGuard.message) void alertAsync(srcColGuard.message); return; }
      const destColGuard = checkRangeGuards(0, targetCol, config.totalRows - 1, targetEndCol);
      if (destColGuard?.blocked) { if (destColGuard.message) void alertAsync(destColGuard.message); return; }

      const hasContent = await hasContentInRange(0, targetCol, config.totalRows - 1, targetEndCol);
      if (hasContent) {
        const confirmed = await confirmAsync(
          "There is data in the destination area. Do you want to replace it?",
          { title: "Calcula", kind: "warning", okLabel: "Yes", cancelLabel: "No" }
        );
        if (!confirmed) return;
      }

      let tx: OwnedUndoTransaction | null = null;
      try {
        tx = ownUndoTransaction(await beginUndoTransaction(`Move ${count} columns`), UNDO_CLOSES);

        // 1. Read all cell data from source columns (sparse), and their STORED
        // values: a moved constant is written from these.
        const sourceCells = await getCellsInCols(minCol, maxCol);
        console.log("[Clipboard] Read", sourceCells.length, "cells from source columns");
        const stored = await storedValuesOf(sourceCells);

        // 2. Clear target columns
        await clearRange(0, targetCol, config.totalRows - 1, targetEndCol);

        // 2b. A MOVED formula is written UNSHIFTED; relocateCellReferences
        // (4b) re-points its references INTO the moved columns and leaves the
        // rest, as Excel's move does (see moveCells).

        // 3. Write source data to target columns
        // Each write names the SOURCE it moves (BUG-0657) and carries its MOVE
        // claim, as in moveRows -- except a source in the target columns, which
        // the clear above emptied.
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newCol = targetCol + (cell.col - minCol);
          const input = movedCellInput(cell, cell.formula, stored);
          if (input.value) {
            const stands = cell.col < targetCol || cell.col > targetEndCol;
            const named = input.pasted && stands;
            updates.push({
              row: cell.row,
              col: newCol,
              ...input,
              ...(named ? { source: pasteSourceOf(sheetContext.activeSheetIndex, cell.row, cell.col, { move: true }) } : {}),
              ...(stands ? { moved: moveClaimOf(sheetContext.activeSheetIndex, cell.row, cell.col) } : {}),
            });
          }
        }
        if (updates.length > 0) {
          await updateCellsBatch(updates);
        }

        // 3b. Copy styles from source cells to target columns
        for (const cell of sourceCells) {
          if (cell.styleIndex > 0) {
            const newCol = targetCol + (cell.col - minCol);
            await setCellStyle(cell.row, newCol, cell.styleIndex);
          }
        }

        // 4. Clear source columns (excluding overlap with target)
        const srcOverlapsTarget =
          minCol <= targetEndCol && maxCol >= targetCol;
        if (srcOverlapsTarget) {
          if (minCol < targetCol) {
            await clearRange(0, minCol, config.totalRows - 1, targetCol - 1);
          }
          if (maxCol > targetEndCol) {
            await clearRange(0, targetEndCol + 1, config.totalRows - 1, maxCol);
          }
        } else {
          await clearRange(0, minCol, config.totalRows - 1, maxCol);
        }

        // 4b. Relocate every reference INTO the moved columns (the moved
        // formulas' own included -- they were written unshifted). The step
        // records the columns as a MOVED block (see moveRows: a drag of whole
        // lines overwrites where it lands; the lines it passes over stay).
        // A refused relocation records no move, so nothing announces one.
        let relocated = false;
        try {
          await relocateCellReferences(
            0, minCol, config.totalRows - 1, maxCol,
            0, targetCol,
          );
          relocated = true;
        } catch (err) {
          console.error("[Clipboard] Failed to relocate cell references:", err);
        }

        await tx.commit();
        // The stores that follow cells (a watch, a bookmark) follow the
        // columns -- only when the step recorded them as moved.
        if (relocated) {
          announceCellsMoved(
            sheetContext.activeSheetIndex, 0, minCol, config.totalRows - 1, maxCol,
            sheetContext.activeSheetIndex, 0, targetCol, tx?.opened === false,
          );
        }

        // 5. Emit change event to trigger grid refresh
        cellEvents.emit({
          row: -1,
          col: -1,
          oldValue: undefined,
          newValue: "structure_change",
          formula: null,
        }, "paste");

        // 6. Update selection to new position
        dispatch(setSelection({
          startRow: 0,
          startCol: targetCol,
          endRow: config.totalRows - 1,
          endCol: targetEndCol,
          type: "columns",
        }));

        console.log("[Clipboard] Move columns complete");
      } catch (error) {
        await tx?.cancel().catch(() => {});
        const msg = typeof error === "string" ? error : (error as Error)?.message || String(error);
        void alertAsync(msg);
      }
    },
    [config.totalRows, dispatch, sheetContext.activeSheetIndex]
  );

  /**
   * Copy cells from source selection to a new position (Ctrl+Drag).
   * Source cells remain intact.
   */
  const copyCellsDrag = useCallback(
    async (source: Selection, targetRow: number, targetCol: number): Promise<void> => {
      console.log("[Clipboard] Copying cells from", source, "to", targetRow, targetCol);

      const srcMinRow = Math.min(source.startRow, source.endRow);
      const srcMaxRow = Math.max(source.startRow, source.endRow);
      const srcMinCol = Math.min(source.startCol, source.endCol);
      const srcMaxCol = Math.max(source.startCol, source.endCol);

      const height = srcMaxRow - srcMinRow + 1;
      const width = srcMaxCol - srcMinCol + 1;

      const destEndRow = targetRow + height - 1;
      const destEndCol = targetCol + width - 1;

      // Check if destination overlaps a protected range (e.g., pivot table)
      const destGuard = checkRangeGuards(targetRow, targetCol, destEndRow, destEndCol);
      if (destGuard?.blocked) {
        if (destGuard.message) void alertAsync(destGuard.message);
        return;
      }

      const hasContent = await hasContentInRange(targetRow, targetCol, destEndRow, destEndCol);
      if (hasContent) {
        const confirmed = await confirmAsync(
          "There is data in the destination area. Do you want to replace it?",
          { title: "Calcula", kind: "warning", okLabel: "Yes", cancelLabel: "No" }
        );
        if (!confirmed) return;
      }

      let tx: OwnedUndoTransaction | null = null;
      try {
        tx = ownUndoTransaction(await beginUndoTransaction(`Copy ${height * width} cells`), UNDO_CLOSES);

        // A data table's body cell is copied as its value (dataTableCopy.ts).
        const sourceCells = (await getViewportCells(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol)).map((c) => copiedCell(c));
        // A copied constant is written from its STORED value (movedCellInput),
        // a copied formula shifted to where it lands (shiftedCopyFormulas).
        const stored = await storedValuesOf(sourceCells);
        const shifted = await shiftedCopyFormulas(sourceCells, targetRow - srcMinRow, targetCol - srcMinCol);
        const cellMap = new Map<string, CellData>();
        for (const cell of sourceCells) {
          cellMap.set(`${cell.row},${cell.col}`, cell);
        }

        for (let r = 0; r < height; r++) {
          for (let c = 0; c < width; c++) {
            const srcRow = srcMinRow + r;
            const srcCol = srcMinCol + c;
            const destRow = targetRow + r;
            const destCol = targetCol + c;

            if (destRow >= config.totalRows || destCol >= config.totalCols) continue;

            const sourceCell = cellMap.get(`${srcRow},${srcCol}`);
            const input = movedCellInput(sourceCell, shifted.get(`${srcRow},${srcCol}`) ?? sourceCell?.formula, stored);
            // The SOURCE this write copies (BUG-0657): written as it stands at
            // the write, its formula shifted to here -- not for a source cell
            // inside the destination, which an earlier write may have replaced.
            const source = inRect(srcRow, srcCol, targetRow, targetCol, destEndRow, destEndCol)
              ? undefined
              : pasteSourceOf(sheetContext.activeSheetIndex, srcRow, srcCol);

            try {
              // A PASTE (formula or stored value) keeps its kind in an @
              // destination; only a display-text fallback is an entry.
              const updatedCells = input.pasted
                ? await updateCellsBatch([{ row: destRow, col: destCol, ...input, ...(source ? { source } : {}) }])
                : (await updateCell(destRow, destCol, input.value)).cells;
              const styleIdx = sourceCell?.styleIndex ?? 0;
              await setCellStyle(destRow, destCol, styleIdx);

              for (const cell of updatedCells) {
                if (cell.sheetIndex !== undefined) continue;
                cellEvents.emit({
                  row: cell.row,
                  col: cell.col,
                  oldValue: undefined,
                  newValue: cell.display,
                  formula: cell.formula ?? null,
                }, "paste");
              }
            } catch (err) {
              const msg = typeof err === "string" ? err : (err as Error)?.message || String(err);
              // CANCEL, never commit. Destination cells are written one at a
              // time (and for a move, the source is not cleared until later),
              // so committing here records a half-finished gesture: destination
              // data already overwritten by the writes that succeeded, with no
              // single undo that puts it back. Cancel discards the partial work
              // instead of enshrining it.
              //
              // Newly load-bearing: a mid-range write can now be refused by
              // sheet protection, so this path went from near-unreachable to
              // routine.
              await tx.cancel().catch(() => {});
              void alertAsync(msg);
              return;
            }
          }
        }

        // No source clearing - this is a copy, not a move

        await tx.commit();

        window.dispatchEvent(new CustomEvent("styles:refresh"));
        window.dispatchEvent(new CustomEvent("grid:refresh"));

        dispatch(setSelection({
          startRow: targetRow,
          startCol: targetCol,
          endRow: targetRow + height - 1,
          endCol: targetCol + width - 1,
          type: source.type,
        }));

        console.log("[Clipboard] Copy cells (drag) complete");
      } catch (error) {
        console.error("[Clipboard] Copy cells (drag) failed:", error);
        await tx?.cancel().catch(() => {});
        void alertAsync(typeof error === "string" ? error : (error as Error)?.message || String(error));
      }
    },
    [config.totalRows, config.totalCols, dispatch, sheetContext.activeSheetIndex]
  );

  /**
   * Copy rows from source position to target position (Ctrl+Drag).
   * Source rows remain intact.
   */
  const copyRowsDrag = useCallback(
    async (sourceStartRow: number, sourceEndRow: number, targetRow: number): Promise<void> => {
      console.log("[Clipboard] Copying rows", sourceStartRow, "-", sourceEndRow, "to", targetRow);

      const minRow = Math.min(sourceStartRow, sourceEndRow);
      const maxRow = Math.max(sourceStartRow, sourceEndRow);
      const count = maxRow - minRow + 1;

      if (targetRow >= minRow && targetRow <= maxRow) {
        console.log("[Clipboard] Target is within source range, no-op");
        return;
      }

      const targetEndRow = targetRow + count - 1;
      const destRowGuard = checkRangeGuards(targetRow, 0, targetEndRow, config.totalCols - 1);
      if (destRowGuard?.blocked) { if (destRowGuard.message) void alertAsync(destRowGuard.message); return; }

      const hasContent = await hasContentInRange(targetRow, 0, targetEndRow, config.totalCols - 1);
      if (hasContent) {
        const confirmed = await confirmAsync(
          "There is data in the destination area. Do you want to replace it?",
          { title: "Calcula", kind: "warning", okLabel: "Yes", cancelLabel: "No" }
        );
        if (!confirmed) return;
      }

      let tx: OwnedUndoTransaction | null = null;
      try {
        tx = ownUndoTransaction(await beginUndoTransaction(`Copy ${count} rows`), UNDO_CLOSES);

        // A data table's body cell is copied as its value (dataTableCopy.ts).
        const sourceCells = (await getCellsInRows(minRow, maxRow)).map((c) => copiedCell(c));
        // Read BEFORE the target is cleared (the two may overlap): a copied
        // constant is written from its STORED value (movedCellInput), a
        // copied formula shifted to where it lands (shiftedCopyFormulas).
        const stored = await storedValuesOf(sourceCells);
        const shifted = await shiftedCopyFormulas(sourceCells, targetRow - minRow, 0);
        await clearRange(targetRow, 0, targetEndRow, config.totalCols - 1);

        // Each write names the SOURCE it copies (BUG-0657) -- except a source
        // in the target rows, which the clear above has just emptied.
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newRow = targetRow + (cell.row - minRow);
          const input = movedCellInput(cell, shifted.get(`${cell.row},${cell.col}`) ?? cell.formula, stored);
          if (input.value) {
            const named = input.pasted && (cell.row < targetRow || cell.row > targetEndRow);
            updates.push({
              row: newRow,
              col: cell.col,
              ...input,
              ...(named ? { source: pasteSourceOf(sheetContext.activeSheetIndex, cell.row, cell.col) } : {}),
            });
          }
        }
        if (updates.length > 0) {
          await updateCellsBatch(updates);
        }

        for (const cell of sourceCells) {
          if (cell.styleIndex > 0) {
            const newRow = targetRow + (cell.row - minRow);
            await setCellStyle(newRow, cell.col, cell.styleIndex);
          }
        }

        // No source clearing - this is a copy

        await tx.commit();

        cellEvents.emit({
          row: -1,
          col: -1,
          oldValue: undefined,
          newValue: "structure_change",
          formula: null,
        }, "paste");

        dispatch(setSelection({
          startRow: targetRow,
          startCol: 0,
          endRow: targetEndRow,
          endCol: config.totalCols - 1,
          type: "rows",
        }));

        console.log("[Clipboard] Copy rows (drag) complete");
      } catch (error) {
        console.error("[Clipboard] Copy rows (drag) failed:", error);
        await tx?.cancel().catch(() => {});
        void alertAsync(typeof error === "string" ? error : (error as Error)?.message || String(error));
      }
    },
    [config.totalCols, dispatch, sheetContext.activeSheetIndex]
  );

  /**
   * Copy columns from source position to target position (Ctrl+Drag).
   * Source columns remain intact.
   */
  const copyColumnsDrag = useCallback(
    async (sourceStartCol: number, sourceEndCol: number, targetCol: number): Promise<void> => {
      console.log("[Clipboard] Copying columns", sourceStartCol, "-", sourceEndCol, "to", targetCol);

      const minCol = Math.min(sourceStartCol, sourceEndCol);
      const maxCol = Math.max(sourceStartCol, sourceEndCol);
      const count = maxCol - minCol + 1;

      if (targetCol >= minCol && targetCol <= maxCol) {
        console.log("[Clipboard] Target is within source range, no-op");
        return;
      }

      const targetEndCol = targetCol + count - 1;
      const destColGuard = checkRangeGuards(0, targetCol, config.totalRows - 1, targetEndCol);
      if (destColGuard?.blocked) { if (destColGuard.message) void alertAsync(destColGuard.message); return; }

      const hasContent = await hasContentInRange(0, targetCol, config.totalRows - 1, targetEndCol);
      if (hasContent) {
        const confirmed = await confirmAsync(
          "There is data in the destination area. Do you want to replace it?",
          { title: "Calcula", kind: "warning", okLabel: "Yes", cancelLabel: "No" }
        );
        if (!confirmed) return;
      }

      let tx: OwnedUndoTransaction | null = null;
      try {
        tx = ownUndoTransaction(await beginUndoTransaction(`Copy ${count} columns`), UNDO_CLOSES);

        // A data table's body cell is copied as its value (dataTableCopy.ts).
        const sourceCells = (await getCellsInCols(minCol, maxCol)).map((c) => copiedCell(c));
        // Read BEFORE the target is cleared (the two may overlap): a copied
        // constant is written from its STORED value (movedCellInput), a
        // copied formula shifted to where it lands (shiftedCopyFormulas).
        const stored = await storedValuesOf(sourceCells);
        const shifted = await shiftedCopyFormulas(sourceCells, 0, targetCol - minCol);
        await clearRange(0, targetCol, config.totalRows - 1, targetEndCol);

        // Each write names the SOURCE it copies (BUG-0657) -- except a source
        // in the target columns, which the clear above has just emptied.
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newCol = targetCol + (cell.col - minCol);
          const input = movedCellInput(cell, shifted.get(`${cell.row},${cell.col}`) ?? cell.formula, stored);
          if (input.value) {
            const named = input.pasted && (cell.col < targetCol || cell.col > targetEndCol);
            updates.push({
              row: cell.row,
              col: newCol,
              ...input,
              ...(named ? { source: pasteSourceOf(sheetContext.activeSheetIndex, cell.row, cell.col) } : {}),
            });
          }
        }
        if (updates.length > 0) {
          await updateCellsBatch(updates);
        }

        for (const cell of sourceCells) {
          if (cell.styleIndex > 0) {
            const newCol = targetCol + (cell.col - minCol);
            await setCellStyle(cell.row, newCol, cell.styleIndex);
          }
        }

        // No source clearing - this is a copy

        await tx.commit();

        cellEvents.emit({
          row: -1,
          col: -1,
          oldValue: undefined,
          newValue: "structure_change",
          formula: null,
        }, "paste");

        dispatch(setSelection({
          startRow: 0,
          startCol: targetCol,
          endRow: config.totalRows - 1,
          endCol: targetEndCol,
          type: "columns",
        }));

        console.log("[Clipboard] Copy columns (drag) complete");
      } catch (error) {
        console.error("[Clipboard] Copy columns (drag) failed:", error);
        await tx?.cancel().catch(() => {});
        void alertAsync(typeof error === "string" ? error : (error as Error)?.message || String(error));
      }
    },
    [config.totalRows, dispatch, sheetContext.activeSheetIndex]
  );

  // Only show marching ants on the sheet where the copy/cut originated
  const isOnSourceSheet =
    clipboard?.sourceSheetIndex != null &&
    clipboard.sourceSheetIndex === sheetContext.activeSheetIndex;

  return {
    cut,
    copy,
    paste,
    hasClipboardData,
    clipboardMode: isOnSourceSheet ? (clipboard?.mode || "none") : "none",
    clipboardSelection: isOnSourceSheet ? (clipboard?.selection || null) : null,
    clearClipboardState,
    moveCells,
    moveRows,
    moveColumns,
    copyCellsDrag,
    copyRowsDrag,
    copyColumnsDrag,
  };
}