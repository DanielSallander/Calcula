//! FILENAME: app/extensions/DataValidation/lib/chevronGeometry.ts
// PURPOSE: Single source of truth for WHERE the in-cell dropdown chevron sits
//          inside a cell, in plain rectangle math (no DOM, no grid state).
// CONTEXT: The renderer PAINTS getChevronRect() and the click interceptor CLAIMS
//          getChevronRect() — so the visible control and its mouse target can
//          never drift apart. Excel parity: clicking the cell selects it, only
//          the arrow button opens the list.

/** Width of the chevron button, in logical (unzoomed) grid pixels. */
export const CHEVRON_BUTTON_SIZE = 18;

/** Inset of the button from the cell's edges, in logical grid pixels. */
export const CHEVRON_BUTTON_MARGIN = 1;

/** An axis-aligned rectangle in whatever coordinate space the caller uses. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The chevron button rectangle for a cell, given that cell's rectangle.
 *
 * The button hugs the cell's right edge and is vertically inset by the margin.
 * It is CLAMPED to the cell: a column narrower than the button yields a
 * narrower button instead of one that spills over the neighbouring cell (a
 * spilled button could never be clicked anyway — the click would resolve to the
 * neighbour's row/col and be tested against the neighbour's own rect).
 */
export function getChevronRect(cell: Rect): Rect {
  const right = cell.x + cell.width - CHEVRON_BUTTON_MARGIN;
  const left = Math.max(cell.x, right - CHEVRON_BUTTON_SIZE);
  const top = cell.y + CHEVRON_BUTTON_MARGIN;
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, cell.height - CHEVRON_BUTTON_MARGIN * 2),
  };
}

/** Point-in-rectangle test (edges inclusive). Empty rectangles never hit. */
export function isPointInRect(x: number, y: number, rect: Rect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  return (
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height
  );
}

/**
 * True when (x, y) — in the SAME coordinate space as `cell` — falls on the
 * chevron button of that cell. Anywhere else in the cell is NOT a chevron hit
 * and must be left to the grid's normal selection handling.
 */
export function isPointInChevron(x: number, y: number, cell: Rect): boolean {
  return isPointInRect(x, y, getChevronRect(cell));
}
