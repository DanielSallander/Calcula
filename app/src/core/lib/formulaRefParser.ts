//! FILENAME: app/src/core/lib/formulaRefParser.ts
// PURPOSE: Parse formula strings to extract cell/range references for highlighting
// CONTEXT: Used by FormulaInput (passive selection highlight) and useEditing (active edit highlight)

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
 * Parse a formula string and extract cell/range references for highlighting.
 * Handles: A1, $A$1, A1:B2, $A$1:$B$2, Sheet1!A1, 'Sheet Name'!A1:B2
 *
 * @param formula - The formula string (must start with "=")
 * @param passive - If true, marks all references as passive (faint display)
 * @returns Array of FormulaReference objects
 */
export function parseFormulaReferences(
  formula: string,
  passive: boolean = false
): FormulaReference[] {
  if (!formula.startsWith("=")) return [];

  const refs: FormulaReference[] = [];

  // Match cell references optionally preceded by a sheet prefix.
  // Sheet prefix: 'Quoted Name'! or UnquotedName!
  // Cell ref: optional $ + 1-3 letters + optional $ + 1-7 digits
  // Range continuation: : + another cell ref
  const refPattern =
    /(?:(?:'[^']*'|[A-Za-z_][A-Za-z0-9_]*)!)?\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?/gi;

  let match;
  let colorIndex = 0;

  while ((match = refPattern.exec(formula)) !== null) {
    const col1 = letterToColumnIndex(match[1]);
    const row1 = parseInt(match[2], 10) - 1;
    const col2 = match[3] ? letterToColumnIndex(match[3]) : col1;
    const row2 = match[4] ? parseInt(match[4], 10) - 1 : row1;

    if (row1 < 0 || col1 < 0) continue;

    refs.push({
      startRow: Math.min(row1, row2),
      startCol: Math.min(col1, col2),
      endRow: Math.max(row1, row2),
      endCol: Math.max(col1, col2),
      color: FORMULA_REFERENCE_COLORS[colorIndex % FORMULA_REFERENCE_COLORS.length],
      isPassive: passive,
    });
    colorIndex++;
  }

  return refs;
}