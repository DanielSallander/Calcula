//! FILENAME: app/extensions/Animation/lib/a1.ts
// PURPOSE: Tiny A1 <-> (row, col) helpers, shared by the timeline panel + dialog.

/** Parse an A1-style address ("B1", "$AA$10") to 0-based row/col, or null. */
export function parseA1(addr: string): { row: number; col: number } | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*$/.exec(addr);
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  col -= 1;
  const row = parseInt(m[2], 10) - 1;
  if (row < 0 || col < 0) return null;
  return { row, col };
}

/** Format a 0-based row/col as an A1 address ("B1"). */
export function toA1(row: number, col: number): string {
  let c = col + 1;
  let s = "";
  while (c > 0) {
    const r = (c - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    c = Math.floor((c - 1) / 26);
  }
  return `${s}${row + 1}`;
}
