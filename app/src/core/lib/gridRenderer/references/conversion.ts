//FILENAME: app/src/lib/gridRenderer/references/conversion.ts
//PURPOSE: Cell and range to Excel-style reference conversion
//CONTEXT: Converts cell coordinates to string references like "A1", "B2:C5", "Sheet1!A1"

import { columnToLetter } from "../../../types";

/**
 * Format a sheet name for use in a reference.
 * Quotes the name if it contains spaces or special characters.
 */
export function formatSheetName(sheetName: string): string {
  // Check if quoting is needed (spaces, special chars, or starts with digit)
  const needsQuoting = /[\s'!\[\]]/.test(sheetName) || /^\d/.test(sheetName);
  
  if (needsQuoting) {
    // Escape any single quotes by doubling them
    const escaped = sheetName.replace(/'/g, "''");
    return `'${escaped}'`;
  }
  
  return sheetName;
}

/**
 * Create a sheet prefix for a reference.
 * Returns empty string if no sheet or same as current sheet.
 */
export function createSheetPrefix(
  targetSheet: string | null,
  currentSheet: string | null
): string {
  if (!targetSheet || targetSheet === currentSheet) {
    return "";
  }
  return `${formatSheetName(targetSheet)}!`;
}

/**
 * Convert a cell position to Excel-style reference (e.g., "A1", "B2", "Sheet1!A1").
 */
export function cellToReference(
  row: number,
  col: number,
  targetSheet?: string | null,
  currentSheet?: string | null
): string {
  const prefix = createSheetPrefix(targetSheet ?? null, currentSheet ?? null);
  return `${prefix}${columnToLetter(col)}${row + 1}`;
}

/**
 * Convert a range to Excel-style reference (e.g., "A1:B2", "Sheet1!A1:B2").
 */
export function rangeToReference(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  targetSheet?: string | null,
  currentSheet?: string | null
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  const prefix = createSheetPrefix(targetSheet ?? null, currentSheet ?? null);

  if (minRow === maxRow && minCol === maxCol) {
    return `${prefix}${columnToLetter(minCol)}${minRow + 1}`;
  }
  return `${prefix}${columnToLetter(minCol)}${minRow + 1}:${columnToLetter(maxCol)}${maxRow + 1}`;
}

/**
 * Convert a column index to an entire column reference (e.g., "A:A", "Sheet1!A:A").
 */
export function columnToReference(
  col: number,
  targetSheet?: string | null,
  currentSheet?: string | null
): string {
  const prefix = createSheetPrefix(targetSheet ?? null, currentSheet ?? null);
  const letter = columnToLetter(col);
  return `${prefix}${letter}:${letter}`;
}

/**
 * Convert a range of columns to a column range reference (e.g., "A:C", "Sheet1!A:C").
 */
export function columnRangeToReference(
  startCol: number,
  endCol: number,
  targetSheet?: string | null,
  currentSheet?: string | null
): string {
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);
  const prefix = createSheetPrefix(targetSheet ?? null, currentSheet ?? null);

  if (minCol === maxCol) {
    const letter = columnToLetter(minCol);
    return `${prefix}${letter}:${letter}`;
  }
  return `${prefix}${columnToLetter(minCol)}:${columnToLetter(maxCol)}`;
}

/**
 * Convert a row index to an entire row reference (e.g., "1:1", "Sheet1!1:1").
 */
export function rowToReference(
  row: number,
  targetSheet?: string | null,
  currentSheet?: string | null
): string {
  const prefix = createSheetPrefix(targetSheet ?? null, currentSheet ?? null);
  const rowNum = row + 1; // Convert from 0-based to 1-based
  return `${prefix}${rowNum}:${rowNum}`;
}

/**
 * Convert a range of rows to a row range reference (e.g., "1:3", "Sheet1!1:3").
 */
export function rowRangeToReference(
  startRow: number,
  endRow: number,
  targetSheet?: string | null,
  currentSheet?: string | null
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const prefix = createSheetPrefix(targetSheet ?? null, currentSheet ?? null);

  if (minRow === maxRow) {
    const rowNum = minRow + 1;
    return `${prefix}${rowNum}:${rowNum}`;
  }
  return `${prefix}${minRow + 1}:${maxRow + 1}`;
}