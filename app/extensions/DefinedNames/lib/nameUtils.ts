//! FILENAME: app/extensions/DefinedNames/lib/nameUtils.ts
// PURPOSE: Helper functions for named range display, parsing, and validation.
// CONTEXT: Used by NameManagerDialog and NewNameDialog components.

import { columnToLetter, letterToColumn } from "../../../src/api";

/**
 * Build a refersTo formula string from selection coordinates.
 * Example: "=Sheet1!$A$1:$B$10"
 */
export function formatRefersTo(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  const startRef = `$${columnToLetter(minCol)}$${minRow + 1}`;
  const endRef = `$${columnToLetter(maxCol)}$${maxRow + 1}`;

  if (minRow === maxRow && minCol === maxCol) {
    return `=${sheetName}!${startRef}`;
  }
  return `=${sheetName}!${startRef}:${endRef}`;
}

/**
 * Parse a refersTo formula to extract range coordinates.
 * Returns null for formulas that aren't simple ranges.
 */
export function parseRefersTo(
  refersTo: string
): {
  sheetName?: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null {
  const match = refersTo.match(
    /^=(?:([^!]+)!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i
  );
  if (!match) return null;

  const sheetName = match[1] || undefined;
  const startCol = letterToColumn(match[2].toUpperCase());
  const startRow = parseInt(match[3], 10) - 1;
  const endCol = match[4]
    ? letterToColumn(match[4].toUpperCase())
    : startCol;
  const endRow = match[5] ? parseInt(match[5], 10) - 1 : startRow;

  return { sheetName, startRow, startCol, endRow, endCol };
}

/**
 * Client-side name validation matching Rust rules.
 */
export function isValidName(name: string): boolean {
  if (!name || name.length === 0) return false;

  const first = name[0];
  if (!/[a-zA-Z_\\]/.test(first)) return false;

  for (let i = 1; i < name.length; i++) {
    const ch = name[i];
    if (!/[a-zA-Z0-9_.]/.test(ch)) return false;
  }

  const upper = name.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE" || upper === "NULL") return false;

  // Cannot be a cell reference
  const cellMatch = name.match(/^([A-Z]+)(\d+)$/i);
  if (cellMatch) {
    const colStr = cellMatch[1].toUpperCase();
    const rowNum = parseInt(cellMatch[2], 10);
    const colNum = letterToColumn(colStr) + 1; // letterToColumn is 0-based
    if (colNum <= 16384 && rowNum >= 1 && rowNum <= 1048576) {
      return false;
    }
  }

  return true;
}

/**
 * Format the scope of a named range for display.
 */
export function formatScope(
  sheetIndex: number | null,
  sheetNames: string[]
): string {
  if (sheetIndex === null) return "Workbook";
  return sheetNames[sheetIndex] ?? `Sheet${sheetIndex + 1}`;
}

/**
 * Format a refersTo value for display in the Name Manager list.
 */
export function formatRangeDisplay(refersTo: string): string {
  // Just show the formula as-is, stripping the leading =
  if (refersTo.startsWith("=")) {
    return refersTo.substring(1);
  }
  return refersTo;
}
