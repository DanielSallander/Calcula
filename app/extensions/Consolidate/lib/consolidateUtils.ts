//! FILENAME: app/extensions/Consolidate/lib/consolidateUtils.ts
// PURPOSE: Pure utility functions extracted from ConsolidateDialog for testability.
// CONTEXT: Range reference parsing and formatting.

import { columnToLetter } from "@api";
import type { SourceRangeEntry } from "../types";

// ============================================================================
// Cell Reference Parsing
// ============================================================================

/**
 * Parse a cell reference like "A1", "$A$1", "B5" to 0-based {row, col}.
 */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const cleaned = ref.trim().replace(/\$/g, "");
  const match = cleaned.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;

  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10);
  if (isNaN(rowNum) || rowNum < 1) return null;

  let colIdx = 0;
  for (let i = 0; i < colStr.length; i++) {
    colIdx = colIdx * 26 + (colStr.charCodeAt(i) - 64);
  }

  return { row: rowNum - 1, col: colIdx - 1 };
}

/**
 * Format a range as a display string: "SheetName!$A$1:$D$10"
 */
export function formatRangeDisplay(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const needsQuotes = /[^A-Za-z0-9_]/.test(sheetName);
  const quotedName = needsQuotes ? `'${sheetName}'` : sheetName;
  return `${quotedName}!$${columnToLetter(startCol)}$${startRow + 1}:$${columnToLetter(endCol)}$${endRow + 1}`;
}

/**
 * Parse a full range reference like "Sheet1!$A$1:$D$10" into a SourceRangeEntry.
 * Returns null if the reference is invalid.
 */
export function parseRangeReference(
  ref: string,
  sheets: Array<{ index: number; name: string }>,
): SourceRangeEntry | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  const bangIdx = trimmed.lastIndexOf("!");
  if (bangIdx === -1) return null;

  let sheetName = trimmed.substring(0, bangIdx);
  const rangePart = trimmed.substring(bangIdx + 1);

  // Remove surrounding quotes from sheet name if present
  if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
    sheetName = sheetName.substring(1, sheetName.length - 1);
  }

  // Find sheet by name (case-insensitive)
  const sheet = sheets.find(
    (s) => s.name.toLowerCase() === sheetName.toLowerCase(),
  );
  if (!sheet) return null;

  const rangeParts = rangePart.split(":");
  if (rangeParts.length !== 2) return null;

  const startRef = parseCellRef(rangeParts[0]);
  const endRef = parseCellRef(rangeParts[1]);
  if (!startRef || !endRef) return null;

  const startRow = Math.min(startRef.row, endRef.row);
  const startCol = Math.min(startRef.col, endRef.col);
  const endRow = Math.max(startRef.row, endRef.row);
  const endCol = Math.max(startRef.col, endRef.col);

  return {
    display: formatRangeDisplay(sheet.name, startRow, startCol, endRow, endCol),
    sheetIndex: sheet.index,
    sheetName: sheet.name,
    startRow,
    startCol,
    endRow,
    endCol,
  };
}
