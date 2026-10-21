//! FILENAME: app/src/core/hooks/useClipboard.ts
// PURPOSE: Custom hook for clipboard operations (cut, copy, paste).
// CONTEXT: Handles reading/writing to system clipboard and cell data operations.
// Updated: Added clearClipboardState for ESC key handling.
// Updated: Selection now moves to pasted range after paste.
// Updated: Copy source remains active after paste (only cut clears clipboard).

import { useCallback, useRef } from "react";
import { writeText as tauriWriteText, readText as tauriReadText, writeHtml as tauriWriteHtml } from "@tauri-apps/plugin-clipboard-manager";
import { useGridContext, getGridStateSnapshot } from "../state/GridContext";
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
} from "../lib/tauri-api";
import type { CellUpdateInput, FormulaShiftInput } from "../lib/tauri-api";
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
   * that is what a formula spells; a sheet renamed after the copy is a link to
   * the old name, which Excel avoids only by cancelling copy mode.
   */
  sourceSheetIndex: number;
  sourceSheetName: string;
  /**
   * The OBJECT the cells were copied from (a floating grid's, P3), or absent
   * for a sheet. With it, `sourceSelection` / `sourceRows` are the object's
   * own (backing) coordinates, `sourceSheetName` is the object's name ("Float1",
   * which a formula spells as a sheet: Paste Link writes `=Float1!$A$1`), and
   * `sourceSheetIndex` is -1 -- never a sheet, so nothing that compares it with
   * the active sheet takes the object's coordinates for the sheet's.
   */
  sourceTarget?: CellTargetRef;
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

/** Whether two cell targets name the same object. */
function sameTarget(a: CellTargetRef | undefined, b: CellTargetRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id;
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

    // Store in internal clipboard
    internalClipboard = {
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
      ...(target ? { sourceTarget: target.ref } : {}),
      text,
      collectionTexts: collectionTexts.size > 0 ? collectionTexts : undefined,
      comments: comments.size > 0 ? comments : undefined,
      validations: validations.size > 0 ? validations : undefined,
    };

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
      internalClipboard = {
        sourceSelection: { ...sel },
        cells,
        sourceRows,
        isCut: true,
        sourceSheetIndex: -1,
        sourceSheetName: owned.label,
        sourceTarget: owned.ref,
        text,
      };
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

      // Store in internal clipboard with cut flag
      internalClipboard = {
        sourceSelection: { ...selection },
        cells,
        sourceRows,
        isCut: true,
        sourceSheetIndex: sheetContext.activeSheetIndex,
        sourceSheetName: sheetContext.activeSheetName,
        text,
        collectionTexts: collectionTexts.size > 0 ? collectionTexts : undefined,
        comments: comments.size > 0 ? comments : undefined,
        validations: validations.size > 0 ? validations : undefined,
      };

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
  }, [selection, getCellRange, cutTarget, dispatch, sheetContext.activeSheetIndex, sheetContext.activeSheetName]);

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

    // THE freshness rule (shared with every Paste Special variant): the
    // internal clipboard answers unless another program put newer text there.
    if (internalClipboard && internalClipboardMatchesSystemText(internalClipboard, textToPaste)) {
      // Use internal clipboard (preserves formulas, formatting, etc.)
      cellsToPaste = internalClipboard.cells;
      pasteHeight = cellsToPaste.length;
      pasteWidth = cellsToPaste[0]?.length || 1;
      usingInternalClipboard = true;
      console.log("[Clipboard] Using internal clipboard data");
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
      pasteWidth = Math.max(...cellsToPaste.map((r) => r.length));
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
    const wasCutOperation = usingInternalClipboard && internalClipboard?.isCut;

    // Shift formulas for copy operations (not cut).
    // Copy adjusts relative references based on offset; cut moves cells as-is.
    const shiftedFormulaMap = new Map<string, string>();
    if (usingInternalClipboard && !wasCutOperation && internalClipboard) {
      const sourceSel = internalClipboard.sourceSelection;
      const sourceMinRow = Math.min(sourceSel.startRow, sourceSel.endRow);
      const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);
      // PER-ROW deltas: a copy that collapsed filter-hidden rows has no single
      // row offset — matrix row r came from sourceRows[r] and lands on
      // targetRow + r. For an ordinary (uncollapsed) copy every entry is the
      // same value, so this is identical to the old single-delta behaviour.
      const rowDeltas = pasteRowDeltas(
        internalClipboard.sourceRows,
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

      // Build batch updates array (single IPC call instead of one per cell)
      const perfPasteStart = performance.now();
      const batchUpdates: CellUpdateInput[] = [];

      for (let r = 0; r < pasteHeight; r++) {
        for (let c = 0; c < pasteWidth; c++) {
          const destRow = targetRow + r;
          const destCol = targetCol + c;

          // Check bounds
          if (destRow >= totalRows || destCol >= totalCols) {
            continue;
          }

          const sourceCell = cellsToPaste[r]?.[c];
          const value = shiftedFormulaMap.get(`${r},${c}`) ?? sourceCell?.formula ?? sourceCell?.display ?? "";

          const update: CellUpdateInput = { row: destRow, col: destCol, value };

          // Include style index when pasting from internal clipboard
          if (usingInternalClipboard) {
            update.styleIndex = sourceCell?.styleIndex ?? 0;
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
        const srcRef = internalClipboard?.sourceTarget;

        if (srcRef || destRef) {
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
            try {
              await clearRangeWithOptions(srcMinRow, srcMinCol, srcMaxRow, srcMaxCol, "all", undefined, {
                target: srcRef,
              });
            } catch (err) {
              console.error("[Clipboard] Failed to clear the cut source:", err);
              void alertAsync(typeof err === "string" ? err : (err as Error)?.message || String(err));
            }
          } else {
            for (let r = srcMinRow; r <= srcMaxRow; r++) {
              for (let c = srcMinCol; c <= srcMaxCol; c++) {
                if (overlaps(r, c)) continue;
                try {
                  if (srcRef) await clearRangeWithOptions(r, c, r, c, "all", undefined, { target: srcRef });
                  else await clearCell(r, c);
                } catch (err) {
                  console.error(`[Clipboard] Failed to clear cut source (${r}, ${c}):`, err);
                }
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

              if (!overlaps) {
                try {
                  await clearCell(r, c);
                } catch (err) {
                  console.error(`[Clipboard] Failed to clear cut source (${r}, ${c}):`, err);
                }
              }
            }
          }
        }

        // Clear cut source reference
        cutSourceRef.current = null;
        if (internalClipboard) {
          internalClipboard.isCut = false;
        }

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
  }, [coreSelection, config.totalRows, config.totalCols, dispatch]);

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
    // Note: We don't clear internalClipboard here, only the visual state
    // This matches Excel behavior where ESC stops marching ants but
    // you can still paste until you copy/cut something else
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

        // 2. Build a map of source cells for quick lookup
        const cellMap = new Map<string, CellData>();
        for (const cell of sourceCells) {
          cellMap.set(`${cell.row},${cell.col}`, cell);
        }

        // 2b. Shift formulas within moved cells to adjust for new position
        const rowDelta = targetRow - srcMinRow;
        const colDelta = targetCol - srcMinCol;
        const formulaCells: { key: string; formula: string }[] = [];
        for (const cell of sourceCells) {
          if (cell.formula) {
            formulaCells.push({ key: `${cell.row},${cell.col}`, formula: cell.formula });
          }
        }
        if (formulaCells.length > 0 && (rowDelta !== 0 || colDelta !== 0)) {
          const shiftInputs: FormulaShiftInput[] = formulaCells.map(fc => ({
            formula: fc.formula,
            rowDelta,
            colDelta,
          }));
          const shiftedFormulas = await shiftFormulasBatch(shiftInputs);
          for (let i = 0; i < formulaCells.length; i++) {
            const existing = cellMap.get(formulaCells[i].key);
            if (existing) {
              cellMap.set(formulaCells[i].key, { ...existing, formula: shiftedFormulas[i] });
            }
          }
        }

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
            const value = sourceCell?.formula || sourceCell?.display || "";

            try {
              const updateResult = await updateCell(destRow, destCol, value);
              const updatedCells = updateResult.cells;

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

        // 4b. Relocate formula references: update any formula on the sheet that
        // referenced cells in the source range to point to the destination
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

        // 1. Read all cell data from source rows (sparse)
        const sourceCells = await getCellsInRows(minRow, maxRow);
        console.log("[Clipboard] Read", sourceCells.length, "cells from source rows");

        // 2. Clear target rows
        await clearRange(targetRow, 0, targetEndRow, config.totalCols - 1);

        // 2b. Shift formulas within moved cells
        const rowDelta = targetRow - minRow;
        const formulaMap = new Map<string, string>();
        const formulaInputCells = sourceCells.filter(c => c.formula);
        if (formulaInputCells.length > 0 && rowDelta !== 0) {
          const shiftInputs: FormulaShiftInput[] = formulaInputCells.map(c => ({
            formula: c.formula!,
            rowDelta,
            colDelta: 0,
          }));
          const shifted = await shiftFormulasBatch(shiftInputs);
          for (let i = 0; i < formulaInputCells.length; i++) {
            formulaMap.set(`${formulaInputCells[i].row},${formulaInputCells[i].col}`, shifted[i]);
          }
        }

        // 3. Write source data to target rows
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newRow = targetRow + (cell.row - minRow);
          const shiftedFormula = formulaMap.get(`${cell.row},${cell.col}`);
          const value = shiftedFormula || cell.formula || cell.display || "";
          if (value) {
            updates.push({ row: newRow, col: cell.col, value });
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

        // 4b. Relocate external formula references
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

        // 1. Read all cell data from source columns (sparse)
        const sourceCells = await getCellsInCols(minCol, maxCol);
        console.log("[Clipboard] Read", sourceCells.length, "cells from source columns");

        // 2. Clear target columns
        await clearRange(0, targetCol, config.totalRows - 1, targetEndCol);

        // 2b. Shift formulas within moved cells
        const colDelta = targetCol - minCol;
        const colFormulaMap = new Map<string, string>();
        const colFormulaCells = sourceCells.filter(c => c.formula);
        if (colFormulaCells.length > 0 && colDelta !== 0) {
          const shiftInputs: FormulaShiftInput[] = colFormulaCells.map(c => ({
            formula: c.formula!,
            rowDelta: 0,
            colDelta,
          }));
          const shifted = await shiftFormulasBatch(shiftInputs);
          for (let i = 0; i < colFormulaCells.length; i++) {
            colFormulaMap.set(`${colFormulaCells[i].row},${colFormulaCells[i].col}`, shifted[i]);
          }
        }

        // 3. Write source data to target columns
        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newCol = targetCol + (cell.col - minCol);
          const shiftedFormula = colFormulaMap.get(`${cell.row},${cell.col}`);
          const value = shiftedFormula || cell.formula || cell.display || "";
          if (value) {
            updates.push({ row: cell.row, col: newCol, value });
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

        // 4b. Relocate external formula references
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
            const value = sourceCell?.formula || sourceCell?.display || "";

            try {
              const updateResult = await updateCell(destRow, destCol, value);
              const updatedCells = updateResult.cells;
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
        await clearRange(targetRow, 0, targetEndRow, config.totalCols - 1);

        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newRow = targetRow + (cell.row - minRow);
          const value = cell.formula || cell.display || "";
          if (value) {
            updates.push({ row: newRow, col: cell.col, value });
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
        await clearRange(0, targetCol, config.totalRows - 1, targetEndCol);

        const updates: CellUpdateInput[] = [];
        for (const cell of sourceCells) {
          const newCol = targetCol + (cell.col - minCol);
          const value = cell.formula || cell.display || "";
          if (value) {
            updates.push({ row: cell.row, col: newCol, value });
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