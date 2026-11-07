//! FILENAME: app/extensions/ConditionalFormatting/lib/appliesTo.ts
// PURPOSE: The Rules Manager's "Applies to" column: a rule's ranges written
//          the way Excel writes them (=$A$2:$E$10, areas separated by the
//          locale's list separator), and read back from what the user typed.
// CONTEXT: Wave-1 finding: the Manager spelled every column past Z as Z
//          (`String.fromCharCode(65 + Math.min(col, 25))`), so AA..XFD all
//          showed as Z, and the column could not be edited. The letters are
//          @api's `columnToLetter` / `letterToColumn`, the ones every other
//          address in the app uses.

import { columnToLetter, letterToColumn } from "@api";
import { sheetNamesEqual } from "@api/sheetNames";
import type { ConditionalFormatRange } from "@api";

/** Excel's last row and column (0-based). */
const LAST_ROW = 1048575;
const LAST_COL = 16383;

function absoluteCell(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

/** One area as Excel's Applies To spells it: $A$1, $A$1:$B$5, $A:$B, $1:$3. */
function describeArea(r: ConditionalFormatRange): string {
  const r0 = Math.min(r.startRow, r.endRow);
  const r1 = Math.max(r.startRow, r.endRow);
  const c0 = Math.min(r.startCol, r.endCol);
  const c1 = Math.max(r.startCol, r.endCol);
  if (r0 === 0 && r1 >= LAST_ROW) return `$${columnToLetter(c0)}:$${columnToLetter(c1)}`;
  if (c0 === 0 && c1 >= LAST_COL) return `$${r0 + 1}:$${r1 + 1}`;
  if (r0 === r1 && c0 === c1) return absoluteCell(r0, c0);
  return `${absoluteCell(r0, c0)}:${absoluteCell(r1, c1)}`;
}

/** A rule's ranges as Excel's Applies To shows them: "=$A$2:$E$10,$G$1". */
export function describeAppliesTo(ranges: readonly ConditionalFormatRange[], separator: string): string {
  return "=" + ranges.map(describeArea).join(separator);
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const COLUMN = /^\$?([A-Za-z]{1,3})$/;
const ROW = /^\$?(\d{1,7})$/;

function cellOf(text: string): { row: number; col: number } | null {
  const m = CELL.exec(text);
  if (!m) return null;
  const col = letterToColumn(m[1].toUpperCase());
  const row = Number(m[2]) - 1;
  if (col < 0 || col > LAST_COL || row < 0 || row > LAST_ROW) return null;
  return { row, col };
}

function areaOf(text: string): ConditionalFormatRange | null {
  const parts = text.split(":");
  if (parts.length === 1) {
    const c = cellOf(parts[0]);
    return c ? { startRow: c.row, startCol: c.col, endRow: c.row, endCol: c.col } : null;
  }
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  const ca = cellOf(a);
  const cb = cellOf(b);
  if (ca && cb) {
    return {
      startRow: Math.min(ca.row, cb.row),
      startCol: Math.min(ca.col, cb.col),
      endRow: Math.max(ca.row, cb.row),
      endCol: Math.max(ca.col, cb.col),
    };
  }
  const colA = COLUMN.exec(a);
  const colB = COLUMN.exec(b);
  if (colA && colB) {
    const x = letterToColumn(colA[1].toUpperCase());
    const y = letterToColumn(colB[1].toUpperCase());
    if (x > LAST_COL || y > LAST_COL) return null;
    return { startRow: 0, startCol: Math.min(x, y), endRow: LAST_ROW, endCol: Math.max(x, y) };
  }
  const rowA = ROW.exec(a);
  const rowB = ROW.exec(b);
  if (rowA && rowB) {
    const x = Number(rowA[1]) - 1;
    const y = Number(rowB[1]) - 1;
    if (x < 0 || y < 0 || x > LAST_ROW || y > LAST_ROW) return null;
    return { startRow: Math.min(x, y), startCol: 0, endRow: Math.max(x, y), endCol: LAST_COL };
  }
  return null;
}

/** What Applies To answers for a typed text: the ranges, or why not. */
export type AppliesToParse = { ok: true; ranges: ConditionalFormatRange[] } | { ok: false; message: string };

/**
 * Read a typed Applies To: an optional leading "=", areas separated by the
 * list separator (either "," or ";" is taken), each an A1 reference -- a cell,
 * a rectangle, whole columns or whole rows, with or without "$". A sheet
 * prefix is taken only when it names `sheetName` (the rule's own sheet, or
 * the floating grid's name): a rule cannot apply to another sheet's cells.
 */
export function parseAppliesTo(text: string, sheetName: string | undefined): AppliesToParse {
  const body = text.trim().replace(/^=/, "").trim();
  if (body === "") return { ok: false, message: "Applies to is empty: enter the cells the rule formats." };
  const ranges: ConditionalFormatRange[] = [];
  for (const raw of body.split(/[,;]/)) {
    let piece = raw.trim();
    const bang = piece.lastIndexOf("!");
    if (bang >= 0) {
      const prefix = piece.slice(0, bang).replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
      if (!sheetName || !sheetNamesEqual(prefix, sheetName)) {
        return { ok: false, message: `A rule formats cells of its own sheet only ("${piece}").` };
      }
      piece = piece.slice(bang + 1);
    }
    const area = areaOf(piece);
    if (!area) return { ok: false, message: `"${raw.trim()}" is not a valid reference.` };
    ranges.push(area);
  }
  return { ok: true, ranges };
}
