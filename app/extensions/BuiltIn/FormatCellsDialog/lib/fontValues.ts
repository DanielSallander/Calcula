//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/lib/fontValues.ts
// PURPOSE: The Font tab's Size field: what a typed size means.
// CONTEXT: Excel takes font sizes from 1 to 409 in HALF POINTS. The backend
//          stores twips now (finer than half points) but the dialog offers what
//          Excel's dialog offers: a size between half points is rounded to the
//          nearest one, and a size outside 1..409 is not taken -- sending it
//          would make the backend refuse the WHOLE OK (it validates the range),
//          which is how 10.5 used to fail silently (survey D1).

/** Excel's smallest font size, in points. */
export const MIN_FONT_SIZE = 1;
/** Excel's largest font size, in points. */
export const MAX_FONT_SIZE = 409;

/**
 * A typed size as the size to apply, or null when it is not one. A decimal
 * COMMA is read as a point, because that is how a size is typed on a
 * comma-decimal locale ("10,5").
 */
export function parseFontSize(raw: string): number | null {
  const t = raw.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  // The TYPED value must be in range (0.8 is refused, not rounded up to 1),
  // and so must its rounding (409.3 would round to 409.5).
  if (n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) return null;
  const halfPoints = Math.round(n * 2) / 2;
  return halfPoints <= MAX_FONT_SIZE ? halfPoints : null;
}
