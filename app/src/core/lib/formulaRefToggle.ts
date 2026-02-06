//! FILENAME: app/src/core/lib/formulaRefToggle.ts
// PURPOSE: Utility for toggling cell reference modes (F4 key behavior).
// CONTEXT: In Excel, pressing F4 while the cursor is on a cell reference
// in a formula cycles through: B2 --> $B$2 --> B$2 --> $B2 --> B2
// This module provides the pure logic for that toggle.
// FIX: When cursor is not directly on a reference (e.g., after closing paren),
//      falls back to the nearest reference before the cursor position.

/**
 * Result of a reference toggle operation.
 */
export interface ToggleResult {
  /** The updated formula string */
  formula: string;
  /** The new cursor position after the toggle */
  cursorPos: number;
}

/**
 * Regex that matches cell references with optional $ markers.
 * Groups: (1) col$, (2) letters, (3) row$, (4) digits
 * Examples: B2, $B$2, B$2, $B2, $AA$100
 */
const CELL_REF_REGEX = /(\$?)([A-Za-z]+)(\$?)(\d+)/g;

/**
 * Internal representation of a parsed cell reference match.
 */
interface RefMatch {
  colAbs: boolean;
  col: string;
  rowAbs: boolean;
  row: string;
  start: number;
  end: number;
}

/**
 * Collect all cell reference matches in a formula string.
 */
function collectReferences(formula: string): RefMatch[] {
  CELL_REF_REGEX.lastIndex = 0;
  const matches: RefMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = CELL_REF_REGEX.exec(formula)) !== null) {
    matches.push({
      colAbs: match[1] === "$",
      col: match[2],
      rowAbs: match[3] === "$",
      row: match[4],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return matches;
}

/**
 * Apply the toggle to a specific reference match and return the new formula.
 */
function applyToggle(formula: string, ref: RefMatch): ToggleResult {
  const { colAbs, col, rowAbs, row, start, end } = ref;

  let newRef: string;
  if (!colAbs && !rowAbs) {
    // B2 --> $B$2 (fully absolute)
    newRef = `$${col}$${row}`;
  } else if (colAbs && rowAbs) {
    // $B$2 --> B$2 (row absolute only)
    newRef = `${col}$${row}`;
  } else if (!colAbs && rowAbs) {
    // B$2 --> $B2 (column absolute only)
    newRef = `$${col}${row}`;
  } else {
    // $B2 --> B2 (fully relative)
    newRef = `${col}${row}`;
  }

  const newFormula = formula.substring(0, start) + newRef + formula.substring(end);
  const newCursorPos = start + newRef.length;

  return { formula: newFormula, cursorPos: newCursorPos };
}

/**
 * Toggle the absolute/relative mode of the cell reference at the cursor position.
 *
 * Cycling order (matches Excel):
 *   B2  -->  $B$2  -->  B$2  -->  $B2  -->  B2
 *
 * If the cursor is directly on a cell reference, toggles that reference.
 * If the cursor is not on a reference (e.g., after a closing paren in =SUM(B2)|),
 * falls back to the nearest reference before the cursor position.
 * If no reference is found, returns the formula unchanged.
 *
 * @param formula - The current formula string (including leading =)
 * @param cursorPos - The cursor position within the formula
 * @returns The updated formula and new cursor position
 */
export function toggleReferenceAtCursor(
  formula: string,
  cursorPos: number,
): ToggleResult {
  const matches = collectReferences(formula);

  if (matches.length === 0) {
    return { formula, cursorPos };
  }

  // First pass: check if cursor is directly on a reference
  for (const ref of matches) {
    if (cursorPos >= ref.start && cursorPos <= ref.end) {
      return applyToggle(formula, ref);
    }
  }

  // Second pass: find the nearest reference before the cursor
  // This handles cases like =SUM(B2)| where cursor is after the closing paren
  let nearest: RefMatch | null = null;
  for (const ref of matches) {
    if (ref.end <= cursorPos) {
      nearest = ref; // Keep overwriting -- last one before cursor wins
    }
  }

  if (nearest) {
    return applyToggle(formula, nearest);
  }

  // No reference found at or before cursor
  return { formula, cursorPos };
}

/**
 * Check if a position in a formula is within a cell reference.
 * Useful for UI hints (e.g., highlighting the reference under cursor).
 * Also falls back to nearest reference before cursor if not directly on one.
 */
export function getReferenceAtCursor(
  formula: string,
  cursorPos: number,
): { start: number; end: number; ref: string } | null {
  const matches = collectReferences(formula);

  // Direct match
  for (const ref of matches) {
    if (cursorPos >= ref.start && cursorPos <= ref.end) {
      const refStr = formula.substring(ref.start, ref.end);
      return { start: ref.start, end: ref.end, ref: refStr };
    }
  }

  // Fallback: nearest before cursor
  let nearest: RefMatch | null = null;
  for (const ref of matches) {
    if (ref.end <= cursorPos) {
      nearest = ref;
    }
  }

  if (nearest) {
    const refStr = formula.substring(nearest.start, nearest.end);
    return { start: nearest.start, end: nearest.end, ref: refStr };
  }

  return null;
}