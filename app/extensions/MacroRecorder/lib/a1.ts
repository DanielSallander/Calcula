//! FILENAME: app/extensions/MacroRecorder/lib/a1.ts
// PURPOSE: A1 <-> (row, col) conversion for the "save as button" anchor field.
// CONTEXT: Kept out of the code generator, which only ever needs the one-way
//          index -> letters direction (for comments).

import { colLetter } from "./actionCodegen";

/** 0-based row/col -> "A1". */
export function formatA1(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

/**
 * Parse "A1" / "$B$7" / "aa12" into 0-based coordinates.
 * Returns null for anything that is not a single-cell reference.
 */
export function parseA1(ref: string): { row: number; col: number } | null {
  const match = ref.trim().replace(/\$/g, "").match(/^([A-Za-z]+)([0-9]+)$/);
  if (!match) return null;
  const rowNumber = parseInt(match[2], 10);
  if (!Number.isFinite(rowNumber) || rowNumber < 1) return null;
  const letters = match[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: rowNumber - 1, col: col - 1 };
}
