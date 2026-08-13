//! FILENAME: app/extensions/FloatingRange/lib/frRefs.ts
// PURPOSE: Build sheet-qualified reference text ("Float1!A1", "'My Float'!A1:B5")
//          for formula insertion — shared by the grid->FR click-pick branch and
//          the FR editor's external-target insertion.

import { columnToLetter } from "@api";

/**
 * Quote a sheet/FR name for formula use when it contains any character outside
 * [A-Za-z0-9_] (the parser accepts the quoted 'Name'! form; internal quotes
 * double). Bare-identifier names pass through unquoted.
 */
export function quoteSheetName(name: string): string {
  if (/^[A-Za-z0-9_]+$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/** "A1" for local (0-based row, col). */
export function a1Cell(row: number, col: number): string {
  return `${columnToLetter(col)}${row + 1}`;
}

/**
 * A sheet-qualified reference: single cell when the rect collapses, "A1:B5"
 * range otherwise. `name` null/empty produces an UNQUALIFIED local ref.
 */
export function buildQualifiedRef(
  name: string | null,
  startRow: number,
  startCol: number,
  endRow = startRow,
  endCol = startCol,
): string {
  const start = a1Cell(Math.min(startRow, endRow), Math.min(startCol, endCol));
  const end = a1Cell(Math.max(startRow, endRow), Math.max(startCol, endCol));
  const cellPart = start === end ? start : `${start}:${end}`;
  return name ? `${quoteSheetName(name)}!${cellPart}` : cellPart;
}
