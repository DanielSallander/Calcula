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
  beginUndoSavepoint,
  rollBackToUndoSavepoint,
} from "../lib/tauri-api";
import type { CellUpdateInput, FormulaShiftInput, UndoSavepoint } from "../lib/tauri-api";
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
} from "../types";
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
  endedCutText = null;
  announceCutModeChange();
}

// ============================================================================
// CUT MODE: how long a Cut stays a pending MOVE
// ============================================================================
//
// A Cut is a pending MOVE of the cells AS THEY WERE AT THE CUT: the paste writes
// that snapshot and then clears the source. It used to stay pending until it
// was pasted, whatever happened in between (review
// NEW-cut-survives-esc-and-source-edits): Cut A1 (5), type 7 into A1, paste at
// C1 -- C1 got the snapshot 5 and A1 was cleared, so the 7 was lost without a
// word; and Cut, Esc, a later Ctrl+V still emptied the source the user thought
// they had cancelled.
//
// Excel ENDS cut mode -- the marching ants go, the Windows clipboard is emptied,
// and the next Paste pastes nothing -- on each of these [LIVE, Excel 16,
// 2026-10-30, fresh hidden instances, keystrokes posted to the grid window and
// COM; clipgroup/probe-*.ps1 in the fix programme's scratchpad]:
//   - Esc;
//   - STARTING an edit in any cell -- a typed character, F2, even one then
//     abandoned with Esc -- so typing into the cut cell itself ends it before
//     anything is stored;
//   - Delete / Clear Contents, a format change (the ribbon's Bold, a COM
//     Font.Bold), Fill Down, inserting rows;
//   - deleting, moving or copying ANY sheet (a third sheet's too) [LIVE,
//     2026-10-30, cutmode/probe-sheetlist.ps1];
//   - the cut's own paste: a second Paste pastes nothing.
// It KEEPS cut mode across a selection move, a sheet switch, adding, renaming
// or hiding a sheet, an Undo, and a COM write of a value -- and a Paste after a
// rename, an Undo or a write moves what the source holds THEN, spelling the
// sheet's new name.
//
// The endings here are announcements every route already makes, so no route has
// to remember a call (`listenForCutModeEndings`): EDIT_STARTED (the one emit
// site of all three Core edit opens, useEditing.ts), CELL_VALUES_CHANGED from a
// clear or a fill, STYLE_ENTRIES_UPDATED (every formatting door announces
// through `announceStyleEntries`), the row/column inserts and deletes on any
// sheet, SHEET_DELETED and SHEET_RENAMED (the tauri-api sheet wrappers announce
// both: the tab strip, the ribbon, a script, a .calp pull -- a rename an MCP
// tool makes inside the backend announces only the sheet LIST, and is not seen
// here), and a document replacement. Esc is `clearClipboardState`.
//
// ONE DELIBERATE DIFFERENCE. This cut moves a SNAPSHOT, so the routes on which
// Excel keeps cut mode and then moves what is there NOW would move a stale copy
// here -- and lose the value the source holds by then. So an undo / redo, and
// any other change that lands ON THE CUT'S OWN CELLS (a script, a validation
// list, a control), END cut mode instead: the next Paste pastes nothing rather
// than a value the user no longer has. A sheet RENAME ends it for the same
// reason (review rev6A#6): the snapshot holds formula TEXT, and a rename repairs
// the workbook's formulas but not that text -- Cut A2 (=Sheet2!B1*2), rename
// Sheet2 to Inputs, Paste: the paste wrote =Sheet2!B1*2, a #REF!, and emptied
// A2. A sheet MOVED or COPIED ends Excel's cut mode but not this one: no name
// changes, and the source sheet is found by its stable id at the paste
// (`cutSourceSheetNow`), so the paste is still exact.

/**
 * Who re-renders when cut mode starts or ends: each mounted `useClipboard`
 * (its `useSyncExternalStore`), so what its host derives from
 * {@link isCutModeLive} at render is never a render behind.
 */
const cutModeSubscribers = new Set<() => void>();

/** Tell the subscribers that cut mode may have started or ended. */
function announceCutModeChange(): void {
  for (const subscriber of [...cutModeSubscribers]) subscriber();
}

/** The `subscribe` of {@link isCutModeLive} as an external store. */
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
 * The text a cut that ENDED put on the system clipboard, for as long as it may
 * still be there. Ending a cut empties the clipboard (`emptyClipboardOfEndedCut`),
 * but that can fail -- another process holding the clipboard open -- and a Paste
 * must then still paste nothing, never the ended cut's text as a copy. Cleared
 * by the next Copy / Cut and by a successful emptying.
 */
let endedCutText: string | null = null;

/** The mounted clipboard hooks' "take the marching ants down" (useClipboard). */
const cutEndedListeners = new Set<() => void>();

/** Clipboard text with Windows line endings normalised (Windows hands `\r\n` back). */
function normalizedClipboardText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Whether `systemText` is what a cut that ended left on the clipboard. */
function isEndedCutText(systemText: string | null | undefined): boolean {
  return endedCutText !== null && !!systemText && normalizedClipboardText(systemText) === endedCutText;
}

/**
 * END cut mode, as Excel does (see CUT MODE above): the pending move is dropped
 * -- the next Paste pastes nothing -- the marching ants go, and the system
 * clipboard is emptied if it still holds what the cut put there. Returns whether
 * a cut was pending; a COPY is left alone.
 */
export function endCutMode(): boolean {
  const clip = internalClipboard;
  if (!clip || !clip.isCut) return false;
  internalClipboard = null;
  endedCutText = normalizedClipboardText(clip.text);
  announceCutModeChange();
  for (const listener of [...cutEndedListeners]) listener();
  void emptyClipboardOfEndedCut(endedCutText);
  return true;
}

/**
 * Empty the system clipboard of the cut that ended (Excel empties it [LIVE]) --
 * only while it still holds that cut's text and nothing newer of ours exists:
 * another program's newer copy is not ours to wipe.
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
    console.warn("[Clipboard] The clipboard could not be emptied of the cut that ended; a Paste still pastes nothing:", err);
  }
}

/**
 * Whether a cell change lands on the pending cut's OWN cells -- the change that
 * makes the cut's snapshot stale (see ONE DELIBERATE DIFFERENCE above). An
 * object's cut never matches (its coordinates are not the sheet's), and a
 * formula cell that only RECALCULATED does not either: the cut moves its
 * formula, not its value. A change names its sheet by index, absent for the
 * sheet on screen; which off-screen sheet an index names cannot be told without
 * a read, so a change on an off-screen sheet at the cut's addresses counts when
 * the cut's sheet is off screen too -- ending a cut is the safe answer.
 */
function changeLandsOnCut(clip: ClipboardData, change: CellValueChange): boolean {
  if (clip.sourceTarget) return false;
  const sel = clip.sourceSelection;
  const minRow = Math.min(sel.startRow, sel.endRow);
  const maxRow = Math.max(sel.startRow, sel.endRow);
  const minCol = Math.min(sel.startCol, sel.endCol);
  const maxCol = Math.max(sel.startCol, sel.endCol);
  if (change.row < minRow || change.row > maxRow || change.col < minCol || change.col > maxCol) return false;
  const matrixRow = clip.sourceRows.indexOf(change.row);
  const kept = matrixRow >= 0 ? clip.cells[matrixRow]?.[change.col - minCol] : null;
  if (kept?.formula && change.formula === kept.formula) return false;
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
 * The announcements that end cut mode whatever they carry (see CUT MODE above).
 * Read when the listeners are installed, never at module load: a module-level
 * read of the event names broke every test that mocks the events module
 * without them and merely IMPORTS this file through @api.
 */
function cutModeEndings(): string[] {
  return [
    AppEvents.EDIT_STARTED,
    AppEvents.STYLE_ENTRIES_UPDATED,
    AppEvents.ROWS_INSERTED,
    AppEvents.COLUMNS_INSERTED,
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_DELETED,
    ApiAppEvents.STRUCTURAL_EDIT_ELSEWHERE,
    ApiAppEvents.STRUCTURAL_UNDO,
    // A sheet deleted (Excel's ending) or renamed (the snapshot's formula text
    // would still spell the old name: the deliberate difference above).
    AppEvents.SHEET_DELETED,
    AppEvents.SHEET_RENAMED,
    // File > New / Open and a checkout replace the document the cut came from
    // (core/lib/file-api.ts `announceBackendStateReplaced`).
    "grid:documentReplaced",
  ];
}

/**
 * Listen for the announcements that END cut mode (see CUT MODE above). Returns
 * the unsubscribe. Every handler asks `endCutMode`, which does nothing unless a
 * cut is pending.
 */
export function listenForCutModeEndings(target: Window = window): () => void {
  const endings = cutModeEndings();
  const cellValuesChanged = AppEvents.CELL_VALUES_CHANGED;
  const mutationRefresh = AppEvents.MUTATION_REFRESH;
  const end = (): void => {
    endCutMode();
  };
  const onCellValues = (event: Event): void => {
    const clip = internalClipboard;
    if (!clip?.isCut) return;
    const payload = (event as CustomEvent<CellValuesChangedPayload | undefined>).detail;
    if (!payload) return;
    // A clear or a fill anywhere ends it (Excel [LIVE]); an undo / redo too
    // (the deliberate difference above).
    if (payload.source === "clear" || payload.source === "fill" || payload.source === "undo" || payload.source === "redo") {
      endCutMode();
      return;
    }
    if ((payload.changes ?? []).some((change) => changeLandsOnCut(clip, change))) endCutMode();
  };
  const onMutationRefresh = (event: Event): void => {
    const source = (event as CustomEvent<Partial<MutationRefreshPayload> | undefined>).detail?.source;
    if (source === "undo" || source === "redo") endCutMode();
  };
  for (const name of endings) target.addEventListener(name, end);
  target.addEventListener(cellValuesChanged, onCellValues);
  target.addEventListener(mutationRefresh, onMutationRefresh);
  return () => {
    for (const name of endings) target.removeEventListener(name, end);
    target.removeEventListener(cellValuesChanged, onCellValues);
    target.removeEventListener(mutationRefresh, onMutationRefresh);
  };
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
 * Write text and HTML to the system clipboard via Tauri plugin.
 */
async function writeToSystemClipboard(text: string, html: string): Promise<void> {
  try {
    // Write HTML (which includes alt plain-text fallback)
    await tauriWriteHtml(html, text);
    console.log("[Clipboard] Written to system clipboard (HTML + text)");
  } catch (err) {
    // Fall back to plain text only
    try {
      await tauriWriteText(text);
      console.log("[Clipboard] Written to system clipboard (text only)");
    } catch (err2) {
      console.warn("[Clipboard] Could not write to system clipboard:", err2);
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
 */
async function takeBackRefusedMove(point: UndoSavepoint): Promise<string | null> {
  try {
    const result = await rollBackToUndoSavepoint(point);
    if (result?.success === true) return null;
    const refusal = typeof result?.refusal === "string" ? result.refusal.trim() : "";
    return refusal !== "" ? refusal : "the undo history did not take it back";
  } catch (err) {
    return errorText(err);
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

    const { cells, sourceRows } = capture;
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

  // Whether a cut is pending, as RENDER state: the host re-renders when a cut
  // starts or ends, so what it derives from `isCutModeLive()` while rendering
  // -- the grid keyboard's "Esc has something to clear"
  // (useSpreadsheetSelection) -- is current. A floating grid's cut draws no
  // marching ants and dispatches nothing, so nothing re-rendered after it.
  useSyncExternalStore(subscribeToCutMode, isCutModeLive, isCutModeLive);

  // CUT MODE's endings (Esc is clearClipboardState below): while this hook is
  // mounted, the announcements that end a pending cut end it, and an ended cut
  // takes its marching ants down.
  useEffect(() => {
    const takeAntsDown = (): void => {
      dispatch(clearClipboard());
    };
    cutEndedListeners.add(takeAntsDown);
    const stopListening = listenForCutModeEndings();
    return () => {
      cutEndedListeners.delete(takeAntsDown);
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
  const paste = useCallback(async (_args?: unknown, ctx?: GridCommandContext) => {
    const owned = objectTargetOf(ctx);
    const selection = owned ? owned.selection : coreSelection;
    const destRef = owned?.ref;
    // The destination's size: the object's write extent, or the sheet's.
    const totalRows = owned ? owned.bounds.rows : config.totalRows;
    const totalCols = owned ? owned.bounds.cols : config.totalCols;
    if (!selection) {
      console.log("[Clipboard] No selection for paste target");
      return;
    }

    console.log("[Clipboard] Pasting to selection:", selection);

    // Try to read from system clipboard first (via Tauri plugin)
    const textToPaste = await readSystemClipboardText();

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
      // What a cut that ENDED left on the clipboard (it could not be emptied):
      // Excel pastes nothing once cut mode is over (see CUT MODE).
      console.log("[Clipboard] The cut ended; nothing to paste");
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

    // Calculate actual paste bounds (clamped to grid bounds)
    const actualPasteHeight = Math.min(pasteHeight, totalRows - targetRow);
    const actualPasteWidth = Math.min(pasteWidth, totalCols - targetCol);

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

      if (colDelta !== 0 || rowDeltas.some((d) => d !== 0)) {
        const formulaEntries: { r: number; c: number; formula: string }[] = [];
        for (let r = 0; r < pasteHeight; r++) {
          if (rowDeltas[r] === 0 && colDelta === 0) continue;
          for (let c = 0; c < pasteWidth; c++) {
            const cell = cellsToPaste![r]?.[c];
            if (cell?.formula) {
              formulaEntries.push({ r, c, formula: cell.formula });
            }
          }
        }

        if (formulaEntries.length > 0) {
          const inputs: FormulaShiftInput[] = formulaEntries.map((e) => ({
            formula: e.formula,
            rowDelta: rowDeltas[e.r],
            colDelta,
          }));
          const shiftedFormulas = await shiftFormulasBatch(inputs);
          for (let i = 0; i < formulaEntries.length; i++) {
            const { r, c } = formulaEntries[i];
            shiftedFormulaMap.set(`${r},${c}`, shiftedFormulas[i]);
          }
        }
      }
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
        : `Paste ${pasteHeight * pasteWidth} cells`;
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

      for (let r = 0; r < pasteHeight; r++) {
        for (let c = 0; c < pasteWidth; c++) {
          const destRow = targetRow + r;
          const destCol = targetCol + c;

          // Check bounds
          if (destRow >= totalRows || destCol >= totalCols) {
            continue;
          }

          const sourceCell = cellsToPaste[r]?.[c];
          const formula = shiftedFormulaMap.get(`${r},${c}`) ?? sourceCell?.formula ?? null;

          const update: CellUpdateInput = { row: destRow, col: destCol, value: formula ?? sourceCell?.display ?? "" };

          // Include style index when pasting from internal clipboard
          if (usingInternalClipboard) {
            update.styleIndex = sourceCell?.styleIndex ?? 0;
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
      } else {
        // Copy+paste: keep clipboard active for multiple pastes
        console.log("[Clipboard] Copy+paste complete, clipboard remains active");
      }

      // Commit the undo transaction
      await tx.commit();

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
    // Esc ENDS a cut: the pending move is dropped and the next Paste pastes
    // nothing, as in Excel [LIVE] (see CUT MODE). A COPY keeps its clipboard
    // here, so a later Paste still pastes it -- Excel ends copy mode on Esc
    // too and empties the clipboard [LIVE, clipgroup/probe-keys3.ps1]; that
    // difference is kept, since losing a copy loses nothing in the workbook.
    endCutMode();
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
        tx = ownUndoTransaction(await beginUndoTransaction(`Move ${height * width} cells`), UNDO_CLOSES);

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

        // 3. Write to destination cells
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
            const input = movedCellInput(sourceCell, sourceCell?.formula, stored);

            try {
              // A formula or a constant's stored value is a PASTE (it keeps its
              // kind in an @ destination); only a display-text fallback goes
              // through the user-input parser as an entry.
              const updatedCells = input.pasted
                ? await updateCellsBatch([{ row: destRow, col: destCol, ...input }])
                : (await updateCell(destRow, destCol, input.value)).cells;

              // Copy style from source cell
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

        // 4. Clear source cells (excluding overlap with destination)
        const destMinRow = targetRow;
        const destMaxRow = targetRow + height - 1;
        const destMinCol = targetCol;
        const destMaxCol = targetCol + width - 1;

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
                console.error(`[Clipboard] Failed to clear source (${r}, ${c}):`, err);
              }
            }
          }
        }

        // 4b. Relocate formula references: every reference INTO the source
        // range -- in the moved formulas themselves, anywhere on this sheet,
        // on other sheets and in defined names -- now names the destination.
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
    [config.totalRows, config.totalCols, dispatch]
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
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newRow = targetRow + (cell.row - minRow);
          const input = movedCellInput(cell, cell.formula, stored);
          if (input.value) {
            updates.push({ row: newRow, col: cell.col, ...input });
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
        // own included -- they were written unshifted)
        try {
          await relocateCellReferences(
            minRow, 0, maxRow, config.totalCols - 1,
            targetRow, 0,
          );
        } catch (err) {
          console.error("[Clipboard] Failed to relocate cell references:", err);
        }

        await tx.commit();

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
    [config.totalCols, dispatch]
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
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newCol = targetCol + (cell.col - minCol);
          const input = movedCellInput(cell, cell.formula, stored);
          if (input.value) {
            updates.push({ row: cell.row, col: newCol, ...input });
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
        // formulas' own included -- they were written unshifted)
        try {
          await relocateCellReferences(
            0, minCol, config.totalRows - 1, maxCol,
            0, targetCol,
          );
        } catch (err) {
          console.error("[Clipboard] Failed to relocate cell references:", err);
        }

        await tx.commit();

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
    [config.totalRows, dispatch]
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

        const sourceCells = await getViewportCells(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol);
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

            try {
              // A PASTE (formula or stored value) keeps its kind in an @
              // destination; only a display-text fallback is an entry.
              const updatedCells = input.pasted
                ? await updateCellsBatch([{ row: destRow, col: destCol, ...input }])
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
    [config.totalRows, config.totalCols, dispatch]
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

        const sourceCells = await getCellsInRows(minRow, maxRow);
        // Read BEFORE the target is cleared (the two may overlap): a copied
        // constant is written from its STORED value (movedCellInput), a
        // copied formula shifted to where it lands (shiftedCopyFormulas).
        const stored = await storedValuesOf(sourceCells);
        const shifted = await shiftedCopyFormulas(sourceCells, targetRow - minRow, 0);
        await clearRange(targetRow, 0, targetEndRow, config.totalCols - 1);

        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newRow = targetRow + (cell.row - minRow);
          const input = movedCellInput(cell, shifted.get(`${cell.row},${cell.col}`) ?? cell.formula, stored);
          if (input.value) {
            updates.push({ row: newRow, col: cell.col, ...input });
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
    [config.totalCols, dispatch]
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

        const sourceCells = await getCellsInCols(minCol, maxCol);
        // Read BEFORE the target is cleared (the two may overlap): a copied
        // constant is written from its STORED value (movedCellInput), a
        // copied formula shifted to where it lands (shiftedCopyFormulas).
        const stored = await storedValuesOf(sourceCells);
        const shifted = await shiftedCopyFormulas(sourceCells, 0, targetCol - minCol);
        await clearRange(0, targetCol, config.totalRows - 1, targetEndCol);

        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newCol = targetCol + (cell.col - minCol);
          const input = movedCellInput(cell, shifted.get(`${cell.row},${cell.col}`) ?? cell.formula, stored);
          if (input.value) {
            updates.push({ row: cell.row, col: newCol, ...input });
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
    [config.totalRows, dispatch]
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