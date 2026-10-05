//! FILENAME: app/src/api/fontSizeLadder.ts
// PURPOSE: Excel's Increase / Decrease Font Size ladder -- ONE copy for every
//          door that grows or shrinks a font: the Home tab's buttons (through
//          extensions/_shared/lib/fontList.ts, which re-exports this) and the
//          shell's mini format toolbar (which cannot import extensions/_shared,
//          so the one copy lives here).
// CONTEXT: Review finding (i), 2026-10-04. The mini toolbar kept its own ladder
//          with no 26 and wrote past both ends (74 at 72pt, 6 at 8pt), so the
//          same button gave a different size by door. NOT the Size dropdown's
//          list: that offers 10.5 (and 6, 7); the buttons never land on them.

/**
 * Excel's ladder. Measured live (rust-format probe1, Excel 16): Decrease from
 * 11 gives 10, 9, 8, 8; Increase from 72 and from 400 changes nothing; Decrease
 * from 10.3 gives 10. A size between two steps moves to the next step in the
 * button's direction, and a size past either end stays where it is.
 */
export const FONT_SIZE_LADDER: readonly number[] = [
  8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
];

/** The size one ladder step from `size`, or null when Excel changes nothing (write nothing). */
export function fontSizeStep(size: number, direction: 1 | -1): number | null {
  if (direction === 1) return FONT_SIZE_LADDER.find((s) => s > size) ?? null;
  const smaller = FONT_SIZE_LADDER.filter((s) => s < size);
  return smaller.length > 0 ? smaller[smaller.length - 1] : null;
}
