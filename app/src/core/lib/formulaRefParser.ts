//! FILENAME: app/src/core/lib/formulaRefParser.ts
// PURPOSE: Parse formula strings to extract cell/range references for highlighting
// CONTEXT: Used by FormulaInput (passive selection highlight) and useEditing (active edit highlight)
// FIX: Now extracts sheet names from cross-sheet references for proper per-sheet highlighting

import type { FormulaReference } from "../types";
import { FORMULA_REFERENCE_COLORS } from "../types";

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