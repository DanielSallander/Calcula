//! FILENAME: app/src/core/lib/formulaRefParser.ts
// PURPOSE: Parse formula strings to extract cell/range references for highlighting
// CONTEXT: Used by FormulaInput (passive selection highlight) and useEditing (active edit highlight)
// FIX: Now extracts sheet names from cross-sheet references for proper per-sheet highlighting
// FIX: Added text position tracking (startIndex, endIndex) for reference dragging feature

import type { FormulaReference } from "../types";
import { FORMULA_REFERENCE_COLORS, columnToLetter } from "../types";

/**
 * Extended FormulaReference with text position information.
 * Used for the reference dragging feature to know where in the formula
 * string each reference is located.
 */
export interface FormulaReferenceWithPosition extends FormulaReference {
  /** Start index of this reference in the formula string (inclusive) */
  textStartIndex: number;
  /** End index of this reference in the formula string (exclusive) */
  textEndIndex: number;
  /** The original reference text (e.g., "A1", "$B$2:C3", "Sheet1!A1") */
  originalText: string;
  /** Whether the start column has $ prefix */
  isStartColAbsolute: boolean;
  /** Whether the start row has $ prefix */
  isStartRowAbsolute: boolean;
  /** Whether the end column has $ prefix (for ranges) */
  isEndColAbsolute: boolean;
  /** Whether the end row has $ prefix (for ranges) */
  isEndRowAbsolute: boolean;
}

/**
 * Convert column letters (e.g. "A", "BC") to a 0-based column index.
 */
function letterToColumnIndex(letters: string): number {
  let result = 0;
  const upper = letters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    result = result * 26 + (upper.charCodeAt(i) - 64);
  }
  return result - 1;
}

/**
 * Extract sheet name from a matched reference prefix.
 * Handles both quoted ('Sheet Name'!) and unquoted (Sheet1!) formats.
 */
function extractSheetName(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;

  // Remove the trailing !
  const withoutBang = prefix.slice(0, -1);

  // Check if it's quoted
  if (withoutBang.startsWith("'") && withoutBang.endsWith("'")) {
    // Remove quotes and unescape internal quotes
    return withoutBang.slice(1, -1).replace(/''/g, "'");
  }

  return withoutBang;
}

/**
 * Parse a formula string and extract cell/range references for highlighting.
 * Handles: A1, $A$1, A1:B2, $A$1:$B$2, Sheet1!A1, 'Sheet Name'!A1:B2
 *
 * @param formula - The formula string (must start with "=")
 * @param passive - If true, marks all references as passive (faint display)
 * @returns Array of FormulaReference objects with sheet names for cross-sheet refs
 */
export function parseFormulaReferences(
  formula: string,
  passive: boolean = false
): FormulaReference[] {
  if (!formula.startsWith("=")) return [];

  const refs: FormulaReference[] = [];

  // Match cell references optionally preceded by a sheet prefix.
  // Group 1: Sheet prefix with ! (optional) - e.g., "Sheet1!" or "'Sheet Name'!"
  // Group 2: First column letters
  // Group 3: First row number
  // Group 4: Second column letters (for ranges, optional)
  // Group 5: Second row number (for ranges, optional)
  const refPattern =
    /((?:'[^']*'|[A-Za-z_][A-Za-z0-9_]*)!)?\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?/gi;

  let match;
  let colorIndex = 0;

  while ((match = refPattern.exec(formula)) !== null) {
    const sheetPrefix = match[1]; // May be undefined
    const col1 = letterToColumnIndex(match[2]);
    const row1 = parseInt(match[3], 10) - 1;
    const col2 = match[4] ? letterToColumnIndex(match[4]) : col1;
    const row2 = match[5] ? parseInt(match[5], 10) - 1 : row1;

    if (row1 < 0 || col1 < 0) continue;

    const sheetName = extractSheetName(sheetPrefix);

    refs.push({
      startRow: Math.min(row1, row2),
      startCol: Math.min(col1, col2),
      endRow: Math.max(row1, row2),
      endCol: Math.max(col1, col2),
      color: FORMULA_REFERENCE_COLORS[colorIndex % FORMULA_REFERENCE_COLORS.length],
      sheetName, // Include sheet name for cross-sheet reference highlighting
      isPassive: passive,
    });
    colorIndex++;
  }

  return refs;
}

/**
 * Parse a formula string and extract cell/range references WITH text position info.
 * This extended version includes the start/end indices and absolute markers,
 * which is needed for the reference dragging feature.
 *
 * @param formula - The formula string (must start with "=")
 * @param passive - If true, marks all references as passive (faint display)
 * @returns Array of FormulaReferenceWithPosition objects
 */
export function parseFormulaReferencesWithPositions(
  formula: string,
  passive: boolean = false
): FormulaReferenceWithPosition[] {
  if (!formula.startsWith("=")) return [];

  const refs: FormulaReferenceWithPosition[] = [];

  // Enhanced pattern that captures the $ markers for absolute references
  // Group 1: Sheet prefix with ! (optional)
  // Group 2: $ before first column (optional)
  // Group 3: First column letters
  // Group 4: $ before first row (optional)
  // Group 5: First row number
  // Group 6: Second part of range (optional): :$?COL$?ROW
  // Group 7: $ before second column (optional)
  // Group 8: Second column letters (optional)
  // Group 9: $ before second row (optional)
  // Group 10: Second row number (optional)
  const refPattern =
    /((?:'[^']*'|[A-Za-z_][A-Za-z0-9_]*)!)?(\$)?([A-Z]{1,3})(\$)?(\d{1,7})(?::(\$)?([A-Z]{1,3})(\$)?(\d{1,7}))?/gi;

  let match;
  let colorIndex = 0;

  while ((match = refPattern.exec(formula)) !== null) {
    const sheetPrefix = match[1]; // May be undefined
    const startColAbsolute = match[2] === "$";
    const col1 = letterToColumnIndex(match[3]);
    const startRowAbsolute = match[4] === "$";
    const row1 = parseInt(match[5], 10) - 1;

    // Range part
    const hasRange = match[7] !== undefined;
    const endColAbsolute = hasRange ? match[6] === "$" : startColAbsolute;
    const col2 = hasRange ? letterToColumnIndex(match[7]) : col1;
    const endRowAbsolute = hasRange ? match[8] === "$" : startRowAbsolute;
    const row2 = hasRange ? parseInt(match[9], 10) - 1 : row1;

    if (row1 < 0 || col1 < 0) continue;

    const sheetName = extractSheetName(sheetPrefix);

    refs.push({
      startRow: Math.min(row1, row2),
      startCol: Math.min(col1, col2),
      endRow: Math.max(row1, row2),
      endCol: Math.max(col1, col2),
      color: FORMULA_REFERENCE_COLORS[colorIndex % FORMULA_REFERENCE_COLORS.length],
      sheetName,
      isPassive: passive,
      // Position info
      textStartIndex: match.index,
      textEndIndex: match.index + match[0].length,
      originalText: match[0],
      // Absolute markers (preserve original order, not normalized)
      isStartColAbsolute: startColAbsolute,
      isStartRowAbsolute: startRowAbsolute,
      isEndColAbsolute: endColAbsolute,
      isEndRowAbsolute: endRowAbsolute,
    });
    colorIndex++;
  }

  return refs;
}

/**
 * Format a sheet name for use in a reference.
 * Quotes the name if it contains spaces or special characters.
 */
function formatSheetNameForRef(sheetName: string): string {
  const needsQuoting = /[\s'![\]]/.test(sheetName) || /^\d/.test(sheetName);
  if (needsQuoting) {
    const escaped = sheetName.replace(/'/g, "''");
    return `'${escaped}'`;
  }
  return sheetName;
}

/**
 * Build a cell reference string from coordinates, preserving absolute markers.
 * Used when moving a reference to a new location while keeping $ prefixes.
 *
 * @param row - 0-based row index
 * @param col - 0-based column index
 * @param isColAbsolute - Whether to prefix column with $
 * @param isRowAbsolute - Whether to prefix row with $
 * @param sheetName - Optional sheet name prefix
 * @returns Reference string like "A1", "$A$1", "Sheet1!$A1", etc.
 */
export function buildCellReference(
  row: number,
  col: number,
  isColAbsolute: boolean,
  isRowAbsolute: boolean,
  sheetName?: string
): string {
  const colPrefix = isColAbsolute ? "$" : "";
  const rowPrefix = isRowAbsolute ? "$" : "";
  const colLetter = columnToLetter(col);
  const rowNum = row + 1;

  if (sheetName) {
    return `${formatSheetNameForRef(sheetName)}!${colPrefix}${colLetter}${rowPrefix}${rowNum}`;
  }
  return `${colPrefix}${colLetter}${rowPrefix}${rowNum}`;
}

/**
 * Build a range reference string from coordinates, preserving absolute markers.
 * Used when moving a range reference to a new location while keeping $ prefixes.
 *
 * @param startRow - 0-based start row
 * @param startCol - 0-based start column
 * @param endRow - 0-based end row
 * @param endCol - 0-based end column
 * @param isStartColAbsolute - Whether to prefix start column with $
 * @param isStartRowAbsolute - Whether to prefix start row with $
 * @param isEndColAbsolute - Whether to prefix end column with $
 * @param isEndRowAbsolute - Whether to prefix end row with $
 * @param sheetName - Optional sheet name prefix
 * @returns Reference string like "A1:B2", "$A$1:$B$2", "Sheet1!A1:B2", etc.
 */
export function buildRangeReference(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  isStartColAbsolute: boolean,
  isStartRowAbsolute: boolean,
  isEndColAbsolute: boolean,
  isEndRowAbsolute: boolean,
  sheetName?: string
): string {
  const startColPrefix = isStartColAbsolute ? "$" : "";
  const startRowPrefix = isStartRowAbsolute ? "$" : "";
  const endColPrefix = isEndColAbsolute ? "$" : "";
  const endRowPrefix = isEndRowAbsolute ? "$" : "";

  const startColLetter = columnToLetter(startCol);
  const endColLetter = columnToLetter(endCol);
  const startRowNum = startRow + 1;
  const endRowNum = endRow + 1;

  // If it's a single cell, don't include the range part
  if (startRow === endRow && startCol === endCol) {
    if (sheetName) {
      return `${formatSheetNameForRef(sheetName)}!${startColPrefix}${startColLetter}${startRowPrefix}${startRowNum}`;
    }
    return `${startColPrefix}${startColLetter}${startRowPrefix}${startRowNum}`;
  }

  if (sheetName) {
    return `${formatSheetNameForRef(sheetName)}!${startColPrefix}${startColLetter}${startRowPrefix}${startRowNum}:${endColPrefix}${endColLetter}${endRowPrefix}${endRowNum}`;
  }
  return `${startColPrefix}${startColLetter}${startRowPrefix}${startRowNum}:${endColPrefix}${endColLetter}${endRowPrefix}${endRowNum}`;
}

/**
 * Find the reference at a given cell position.
 * Returns the index of the reference that contains the cell, or -1 if none.
 *
 * @param refs - Array of FormulaReferenceWithPosition from parseFormulaReferencesWithPositions
 * @param row - 0-based row index
 * @param col - 0-based column index
 * @param sheetName - Current sheet name (for matching cross-sheet references)
 * @param formulaSourceSheet - The sheet where the formula is being edited
 * @returns Index of the matching reference, or -1 if not found
 */
export function findReferenceAtCell(
  refs: FormulaReferenceWithPosition[],
  row: number,
  col: number,
  sheetName?: string,
  formulaSourceSheet?: string
): number {
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];

    // Check if the reference's sheet matches the current sheet
    // If ref has no sheet name, it refers to the formula's source sheet
    const refSheet = ref.sheetName ?? formulaSourceSheet;
    if (sheetName && refSheet && sheetName.toLowerCase() !== refSheet.toLowerCase()) {
      continue;
    }

    // Check if the cell is within the reference bounds
    if (
      row >= ref.startRow &&
      row <= ref.endRow &&
      col >= ref.startCol &&
      col <= ref.endCol
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Update a formula by replacing a reference at the given position with a new reference.
 *
 * @param formula - The original formula string
 * @param ref - The reference to replace (with text position info)
 * @param newStartRow - New start row (0-based)
 * @param newStartCol - New start column (0-based)
 * @param newEndRow - New end row (0-based), defaults to newStartRow for single cells
 * @param newEndCol - New end column (0-based), defaults to newStartCol for single cells
 * @returns Updated formula string
 */
export function updateFormulaReference(
  formula: string,
  ref: FormulaReferenceWithPosition,
  newStartRow: number,
  newStartCol: number,
  newEndRow?: number,
  newEndCol?: number
): string {
  // Use original positions if not moving to a range
  const finalEndRow = newEndRow ?? (ref.startRow === ref.endRow ? newStartRow : newStartRow + (ref.endRow - ref.startRow));
  const finalEndCol = newEndCol ?? (ref.startCol === ref.endCol ? newStartCol : newStartCol + (ref.endCol - ref.startCol));

  // Build the new reference string
  const isRange = finalEndRow !== newStartRow || finalEndCol !== newStartCol;

  let newRefText: string;
  if (isRange) {
    newRefText = buildRangeReference(
      newStartRow, newStartCol, finalEndRow, finalEndCol,
      ref.isStartColAbsolute, ref.isStartRowAbsolute,
      ref.isEndColAbsolute, ref.isEndRowAbsolute,
      ref.sheetName
    );
  } else {
    newRefText = buildCellReference(
      newStartRow, newStartCol,
      ref.isStartColAbsolute, ref.isStartRowAbsolute,
      ref.sheetName
    );
  }

  // Replace the old reference with the new one
  return formula.substring(0, ref.textStartIndex) + newRefText + formula.substring(ref.textEndIndex);
}