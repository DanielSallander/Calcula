//! FILENAME: app/extensions/Reports/lib/cellRef.ts
// PURPOSE: Tiny A1-reference helpers shared by the Reports dialogs/tab.

/** 0-based column index -> letters (0 = A, 26 = AA). */
export function colLetter(col: number): string {
  let n = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** 0-based (row, col) -> "B4"-style reference. */
export function cellRef(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}
