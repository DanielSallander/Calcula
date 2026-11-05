//! FILENAME: app/src/core/lib/gridRenderer/layout/shrinkToFit.ts
// PURPOSE: The font size Shrink to Fit paints a value at -- one rule for every
//          painter (rendering/cells.ts for the grid and its panes,
//          rendering/styledCellBox.ts for a floating grid's cells).
// CONTEXT: Pure. Both painters used to compute
//          `Math.floor(fontSize * available / width)`, so the size was FLOORED to
//          a whole point: an 11pt heading that needed 5.7pt to fit was painted at
//          5pt, visibly smaller than Excel's and leaving a gap at the right.
//
// EXCEL'S RULE, MEASURED [LIVE] (Excel 16, 2026-11-04; a fresh hidden instance,
// a new unsaved workbook, Normal font Calibri 11, "Shrinkable heading text" with
// Shrink to Fit in columns 59.6 / 44.6 / 77.3pt wide, exported to PDF and the
// content stream's Tf operands read back): the value was set at 5.76, 4.20 and
// 7.56pt (the reference 11pt cell reads 11.04 in the same stream, so PDF's own
// scale is ~1.004). None of them is a whole or a half point: Excel scales the
// font CONTINUOUSLY to the width. A value that already fits is not enlarged.

/**
 * The size, in points, to paint a Shrink to Fit value at.
 *
 * `textWidth` is the value's width measured at `fontSize`; `availableWidth` the
 * room the painter has for it (after padding and indent). The width of text is
 * proportional to its font size, so scaling by `available / width` makes it
 * fit exactly. Never larger than `fontSize` (Excel only shrinks), never below a
 * hairline 1pt (a zero-width column must not produce a zero or negative font).
 */
export function shrinkToFitFontSize(fontSize: number, textWidth: number, availableWidth: number): number {
  if (!(textWidth > availableWidth) || !(availableWidth > 0)) return fontSize;
  const scaled = fontSize * (availableWidth / textWidth);
  return Math.max(1, Math.min(fontSize, scaled));
}
