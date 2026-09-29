//! FILENAME: app/extensions/FloatingRange/lib/frRefs.ts
// PURPOSE: Build sheet-qualified reference text ("Float1!A1", "'My Float'!A1:B5")
//          for formula insertion — shared by the grid->FR click-pick branch and
//          the FR editor's external-target insertion.

import { columnToLetter } from "@api";
import { quoteSheetNameForFormula } from "@api/externalEdit";

/**
 * Quote a sheet/FR name for formula use: Core's ONE rule for text handed to an
 * external edit (`quoteSheetNameForFormula`, the backend's
 * `is_bare_sheet_name`). This extension's own rule -- bare for anything in
 * [A-Za-z0-9_] -- left "2024Budget" and "TRUE" bare, which the parser rejects,
 * and quoted a sheet differently from Core's header picks in the same edit
 * (review B, 2026-09-28).
 */
export function quoteSheetName(name: string): string {
  return quoteSheetNameForFormula(name);
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
