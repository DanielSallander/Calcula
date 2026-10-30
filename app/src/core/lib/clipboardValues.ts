//! FILENAME: app/src/core/lib/clipboardValues.ts
// PURPOSE: What a copy of CONSTANTS carries to the paste: the source cells'
//          STORED values, and the one rule for writing them back.
// CONTEXT: The internal clipboard's cell matrix (`ClipboardData.cells`) holds
//          `CellData`, whose only value is the formatted DISPLAY text. Every
//          paste of a constant used to write that text back through the
//          typed-entry ladder (core/engine/src/typed_entry.rs), as if the user
//          had typed it -- so a paste was only as exact as the source's number
//          format:
//            - 1.23456 shown under 0.00 pasted as 1.23;
//            - 3.14159265358979 under General ("3.1415926536") lost digits, and
//              1234567890123456 ("1.23457E+15") lost ten of them;
//            - "5,50 kr" or a date spelled in a format the parser does not read
//              came back as TEXT;
//            - a number pasted into a Text-formatted (@) cell was stored as text.
//          Excel pastes the stored value (measured live through COM,
//          2026-10-29: Paste and Paste Values of 1.23456 under 0.00 -> 1.23456;
//          a date under yyyy-mm-dd, Paste Values into General -> the serial
//          43983; 50% -> 0.5; the text '00123 -> the text 00123; TRUE / #N/A /
//          the number 5 into an @ cell -> the boolean / the error / the number,
//          the cell keeping its @). So a copy now also reads its cells TYPED
//          (`readClipboardValues`) and a paste writes a constant from that
//          (`pastedConstantInput`), flagged as a paste (`CellUpdateInput.pasted`)
//          so a Text-formatted cell keeps its kind. The system clipboard's text and HTML for
//          OTHER programs stay the display text, and text pasted from another
//          program keeps the entry ladder: that is typing, and Excel parses it.

import { getRangeCellsTyped } from "./tauri-api";
import { getCellTargetCellsTyped } from "../../api/cellTarget";
import type { CellTargetRef, CellValueType, TypedCellData } from "../types";

/**
 * One copied cell's STORED value, as the engine types it (`TypedCellData`'s
 * `type` and `value`): a number is the number (5.5, never "5,50 kr"), an
 * error its Excel literal ("#N/A"). A FORMULA cell's entry is its RESULT --
 * what Paste Values pastes; Paste and Paste Formulas paste the formula itself.
 */
export interface ClipboardCellValue {
  type: CellValueType;
  value: number | string | boolean | null;
}

/**
 * What a paste writes for one copied constant: a `CellUpdateInput`'s value and
 * flags, ready to spread into one (`{ row, col, ...constant }`).
 */
export interface PastedConstant {
  /** The cell input: invariant text the ladder reads back as the same value. */
  value: string;
  /** Always true: the input is never read in the app locale ("3.5" is 3.5 under de-DE too). */
  invariant: true;
  /**
   * Always true: a paste, not an entry (`CellUpdateInput.pasted`), so a number,
   * TRUE / FALSE or an error keeps its kind in a Text-formatted (@) cell, where
   * the ladder stores a TYPED entry verbatim -- Excel keeps a pasted value's
   * kind there. The backend decides it in the same write; no detour follows.
   */
  pasted: true;
}

/** A List / Dict collection's display ("[List(3)]"): pasted through its JSON text, never as a constant. */
function isCollectionDisplay(text: string): boolean {
  return text.startsWith("[List(") || text.startsWith("[Dict(");
}

/**
 * The cell input that pastes `stored` EXACTLY, or null when the paste must keep
 * its old route (the cell's `display` text through the ladder): a collection, a
 * number with no finite value, an error the read did not spell, or a cell the
 * typed read did not return although it shows something.
 *
 * - a NUMBER: its shortest round-trip text (`String(1.23456)`), written
 *   invariant -- never the display, never the destination's locale;
 * - TEXT: behind an apostrophe, the ladder's own "store the rest verbatim"
 *   escape, so "00123", "TRUE", "=A1" and "  x  " stay exactly that text (and,
 *   on the invariant path, the escape implies no Text format: Paste Values
 *   leaves the destination's format alone, as Excel does);
 * - TRUE / FALSE and an ERROR: their literal, which the ladder reads back as
 *   the boolean and the error;
 * - EMPTY (no stored value): the empty input, which clears the cell.
 *
 * `display` is the copied cell's display text ("" for an empty position).
 */
export function pastedConstantInput(
  stored: ClipboardCellValue | null | undefined,
  display: string,
): PastedConstant | null {
  if (!stored || stored.type === "empty") {
    // The typed read is sparse: no entry is an empty cell. A cell that shows
    // something the read did not return is not one this rule can vouch for.
    return display === "" ? { value: "", invariant: true, pasted: true } : null;
  }
  switch (stored.type) {
    case "number":
      return typeof stored.value === "number" && Number.isFinite(stored.value)
        ? { value: String(stored.value), invariant: true, pasted: true }
        : null;
    case "boolean":
      return typeof stored.value === "boolean"
        ? { value: stored.value ? "TRUE" : "FALSE", invariant: true, pasted: true }
        : null;
    case "error":
      return typeof stored.value === "string" && stored.value.startsWith("#")
        ? { value: stored.value, invariant: true, pasted: true }
        : null;
    case "text": {
      const text = typeof stored.value === "string" ? stored.value : String(stored.value ?? "");
      if (isCollectionDisplay(text) || isCollectionDisplay(display)) return null;
      return { value: `'${text}`, invariant: true, pasted: true };
    }
    default:
      return null;
  }
}

/** The most cells one typed read asks the backend for (`MAX_TYPED_RANGE_CELLS`, commands/data.rs). */
export const CLIPBOARD_TYPED_READ_BAND = 100_000;

/**
 * The copied cells' stored values, as a matrix ALIGNED with the clipboard's
 * `cells`: row `r` is absolute row `sourceRows[r]`, column `c` is `minCol + c`,
 * and null is an empty cell. Read typed in bands of at most
 * {@link CLIPBOARD_TYPED_READ_BAND} cells (the backend refuses more): rectangles
 * of whole copied rows, spanning a gap between two copied rows (a filtered
 * copy's hidden rows cost a few cells, not an extra call), from the ACTIVE
 * sheet or -- with `target` -- an object's cells in its own coordinates.
 *
 * Rejects when a read fails; the caller then copies without values and the
 * paste keeps the display-text route for that copy.
 */
export async function readClipboardValues(
  sourceRows: readonly number[],
  minCol: number,
  maxCol: number,
  target?: CellTargetRef,
): Promise<(ClipboardCellValue | null)[][]> {
  const width = maxCol - minCol + 1;
  const matrix: (ClipboardCellValue | null)[][] = [];
  const matrixRowOf = new Map<number, number>();
  for (let r = 0; r < sourceRows.length; r++) {
    matrix.push(new Array<ClipboardCellValue | null>(Math.max(0, width)).fill(null));
    matrixRowOf.set(sourceRows[r], r);
  }
  await readTypedBands(sourceRows, minCol, maxCol, target, (cell) => {
    const r = matrixRowOf.get(cell.row);
    if (r !== undefined) matrix[r][cell.col - minCol] = { type: cell.type, value: cell.value };
  });
  return matrix;
}

/**
 * The stored values of the cells in rows `r0..r1`, columns `c0..c1` of the
 * ACTIVE sheet, keyed by their ABSOLUTE "row,col" -- sparse, for a gesture
 * that reads its source sparsely (a move of whole rows or columns), where a
 * dense matrix of the bounding box would be mostly empty. Banded like
 * {@link readClipboardValues}; rejects when a read fails.
 */
export async function readStoredValues(
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): Promise<Map<string, ClipboardCellValue>> {
  const rows: number[] = [];
  for (let r = r0; r <= r1; r++) rows.push(r);
  const out = new Map<string, ClipboardCellValue>();
  await readTypedBands(rows, c0, c1, undefined, (cell) => {
    out.set(`${cell.row},${cell.col}`, { type: cell.type, value: cell.value });
  });
  return out;
}

/**
 * Typed reads over `rows` (ascending) x `minCol..maxCol`, in bands of at most
 * {@link CLIPBOARD_TYPED_READ_BAND} cells, each returned cell inside the asked
 * rows and columns handed to `visit`.
 */
async function readTypedBands(
  rows: readonly number[],
  minCol: number,
  maxCol: number,
  target: CellTargetRef | undefined,
  visit: (cell: TypedCellData) => void,
): Promise<void> {
  const width = maxCol - minCol + 1;
  if (rows.length === 0 || width <= 0) return;
  const wanted = new Set<number>(rows);
  const colBand = Math.min(width, CLIPBOARD_TYPED_READ_BAND);
  const rowsPerRead = Math.max(1, Math.floor(CLIPBOARD_TYPED_READ_BAND / colBand));
  for (let bandStart = minCol; bandStart <= maxCol; bandStart += colBand) {
    const bandEnd = Math.min(maxCol, bandStart + colBand - 1);
    let i = 0;
    while (i < rows.length) {
      const first = rows[i];
      let j = i;
      while (j + 1 < rows.length && rows[j + 1] - first + 1 <= rowsPerRead) j++;
      const last = rows[j];
      const read: TypedCellData[] = target
        ? await getCellTargetCellsTyped(target, { startRow: first, startCol: bandStart, endRow: last, endCol: bandEnd })
        : await getRangeCellsTyped(first, bandStart, last, bandEnd);
      for (const cell of read ?? []) {
        if (cell.col < bandStart || cell.col > bandEnd || !wanted.has(cell.row)) continue;
        visit(cell);
      }
      i = j + 1;
    }
  }
}
