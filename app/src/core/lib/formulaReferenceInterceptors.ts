//! FILENAME: app/src/core/lib/formulaReferenceInterceptors.ts
// PURPOSE: Generic formula reference interceptor registry for the grid.
// CONTEXT: Extensions register interceptor functions that can override the
// default cell reference insertion when clicking a cell in formula mode.
// If any interceptor returns a result, the default "A1" reference insertion
// is replaced with the interceptor's custom formula text.
// NOTE: This is a Core primitive. The API layer re-exports it for extensions.

import { columnToLetter } from "../types";
import { quoteSheetNameForFormula } from "./formulaEditTarget";

// ============================================================================
// Types
// ============================================================================

/**
 * The result of a formula reference interception.
 * Contains the text to insert and optional cell coordinates for highlighting.
 */
export interface FormulaReferenceOverride {
  /** The formula text to insert (e.g., 'GETPIVOTDATA("Sum of Sales",B5,"Region","North")') */
  text: string;
  /** Row of the cell reference to highlight in the formula bar */
  highlightRow: number;
  /** Column of the cell reference to highlight in the formula bar */
  highlightCol: number;
}

/**
 * An async function that can intercept a formula cell reference insertion.
 * Return a FormulaReferenceOverride to replace the default reference, or null to pass through.
 */
export type FormulaReferenceInterceptorFn = (
  row: number,
  col: number
) => Promise<FormulaReferenceOverride | null>;

// ============================================================================
// Internal State
// ============================================================================

const interceptors = new Set<FormulaReferenceInterceptorFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a formula reference interceptor.
 * @param interceptor - Async function that can override formula reference insertion.
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerFormulaReferenceInterceptor(
  interceptor: FormulaReferenceInterceptorFn
): () => void {
  interceptors.add(interceptor);
  return () => {
    interceptors.delete(interceptor);
  };
}

/**
 * Check all registered formula reference interceptors for a given cell.
 * Returns the first non-null override, or null for default behavior.
 */
export async function checkFormulaReferenceInterceptors(
  row: number,
  col: number
): Promise<FormulaReferenceOverride | null> {
  for (const interceptor of interceptors) {
    try {
      const result = await interceptor(row, col);
      if (result) {
        return result;
      }
    } catch (error) {
      console.error("Error in formula reference interceptor:", error);
    }
  }
  return null;
}

// ============================================================================
// A pick's text made on ANOTHER sheet than the formula's
// ============================================================================

/** A character that continues a name or a reference (so a match beside it is part of something longer). */
const REF_NEIGHBOUR_BEFORE = /[A-Za-z0-9_.!$']/;
const REF_NEIGHBOUR_AFTER = /[A-Za-z0-9_(]/;

/**
 * Qualify the cell reference an intercepted pick's TEXT carries -- the pivot
 * cell of a GETPIVOTDATA call, `$C$3` -- with the sheet it was picked on, so
 * the text means the same cell from a formula that lives elsewhere: an
 * external edit's formula (E2: a floating grid's formula lives on its backing
 * sheet) or Core's own edit parked on another sheet (W14). An interceptor
 * builds its text from the cell's coordinates alone and cannot know where the
 * formula lives. The reference is the interceptor's highlight cell, found as a
 * standalone token in any of its four `$` forms, outside string literals and
 * not already sheet-qualified; the sheet is spelled by the parser's rule
 * (quoteSheetNameForFormula). Null when the text carries no such token: the
 * caller inserts the plain qualified cell reference rather than a formula that
 * points at the wrong sheet.
 */
export function qualifyInterceptedCellRef(
  text: string,
  row: number,
  col: number,
  sheetName: string,
): string | null {
  if (!sheetName) return null;
  const token = new RegExp(`\\$?${columnToLetter(col)}\\$?${row + 1}`, "gi");
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    const at = match.index;
    const end = at + match[0].length;
    // Inside a string literal? Excel doubles a quote to escape it, so the
    // parity of the quotes before the match answers either way.
    const quotesBefore = (text.slice(0, at).match(/"/g) ?? []).length;
    if (quotesBefore % 2 === 1) continue;
    if (at > 0 && REF_NEIGHBOUR_BEFORE.test(text[at - 1])) continue;
    if (end < text.length && REF_NEIGHBOUR_AFTER.test(text[end])) continue;
    return `${text.slice(0, at)}${quoteSheetNameForFormula(sheetName)}!${text.slice(at)}`;
  }
  return null;
}
