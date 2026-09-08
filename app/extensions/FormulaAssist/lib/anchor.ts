//! FILENAME: app/extensions/FormulaAssist/lib/anchor.ts
// PURPOSE: Where on screen the popover should sit — over the cell the formula
//          is being written for, or under the formula bar when that cell is not
//          on screen.
// CONTEXT: THE GEOMETRY IS WALKED, NEVER MULTIPLIED. `col * defaultCellWidth`
//          is a documented repo mistake with a body count: the Macro Recorder
//          placed a button that way and produced an invisible control while the
//          backend reported success, and 93 sites once agreed on a header
//          gutter the product does not have. Columns have individual widths,
//          rows have individual heights, and hidden ones measure ZERO — so the
//          only correct answer accumulates the real values.
//
//          This is the exact inverse of `getCellFromPixel`
//          (core/lib/gridRenderer/interaction/hitTesting.ts): gutter, plus the
//          widths of every column before this one, minus the scroll offset,
//          all scaled by zoom and offset by the canvas layer's page position.
//          When the two disagree the popover lands on the wrong cell, so the
//          shape is kept deliberately recognisable against that function.
//
//          FREEZE PANES ARE NOT MODELLED, and that is a decision rather than an
//          omission: a frozen pane shifts the cell's x/y by the frozen band's
//          width, and getting that subtly wrong puts the popover a few
//          centimetres from the cell with no visible reason. `cellIsVisible`
//          returns false whenever a freeze or split is in force, and the caller
//          falls back to the formula-bar position — a placement that is always
//          right rather than usually right.

import { rowHeaderGutter, colHeaderGutter, getGridStateSnapshot } from "@api/grid";
import type { AnchorRect } from "@api/uiTypes";

/**
 * The DOM element the grid canvas and every layer over it live in.
 *
 * `data-grid-canvas-layer` is a DO-NOT-BREAK test contract (see
 * Spreadsheet.tsx) — it marks the grid MINUS its scrollbars, which is exactly
 * the box these coordinates are measured in.
 */
const CANVAS_LAYER_SELECTOR = "[data-grid-canvas-layer]";

/** Where the popover goes when the cell cannot be located on screen. */
export const FORMULA_BAR_FALLBACK: AnchorRect = { x: 220, y: 96, width: 0, height: 0 };

interface Dimensions {
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  hiddenRows?: Set<number>;
  hiddenCols?: Set<number>;
}

/** One column's width in LOGICAL pixels. Hidden means zero, not "default". */
function columnWidth(
  col: number,
  dims: Dimensions,
  defaultWidth: number,
): number {
  if (dims.hiddenCols?.has(col)) return 0;
  const custom = dims.columnWidths?.get(col);
  return custom !== undefined && custom > 0 ? custom : defaultWidth;
}

/** One row's height in LOGICAL pixels. Hidden means zero. */
function rowHeight(row: number, dims: Dimensions, defaultHeight: number): number {
  if (dims.hiddenRows?.has(row)) return 0;
  const custom = dims.rowHeights?.get(row);
  return custom !== undefined && custom > 0 ? custom : defaultHeight;
}

/**
 * The on-screen rect of a cell, or null when it cannot be placed.
 *
 * Null is returned for every case the caller must not guess at: no grid state,
 * no canvas element, a freeze or split in force, or a cell scrolled out of the
 * visible box. Each of those has a correct fallback and none of them has a
 * correct approximation.
 */
export function cellAnchorRect(row: number, col: number): AnchorRect | null {
  const state = getGridStateSnapshot();
  if (!state) return null;

  const freeze = state.freezeConfig;
  if (freeze && (freeze.freezeRow !== null || freeze.freezeCol !== null)) return null;
  const split = state.splitConfig;
  if (split && (split.splitRow !== null || split.splitCol !== null)) return null;

  const host = document.querySelector<HTMLElement>(CANVAS_LAYER_SELECTOR);
  if (!host) return null;
  const hostRect = host.getBoundingClientRect();
  if (hostRect.width === 0 || hostRect.height === 0) return null;

  const config = state.config;
  const dims = state.dimensions as Dimensions;
  const defaultWidth = config.defaultCellWidth || 100;
  const defaultHeight = config.defaultCellHeight || 20;
  const zoom = state.zoom || 1;

  // WALK. Column 0 to the target, adding real widths; hidden columns add zero.
  let x = rowHeaderGutter(config);
  for (let c = 0; c < col; c++) x += columnWidth(c, dims, defaultWidth);
  x -= state.viewport.scrollX || 0;

  let y = colHeaderGutter(config);
  for (let r = 0; r < row; r++) y += rowHeight(r, dims, defaultHeight);
  y -= state.viewport.scrollY || 0;

  const width = columnWidth(col, dims, defaultWidth);
  const height = rowHeight(row, dims, defaultHeight);
  // A hidden target has no rect at all — there is nothing on screen to point at.
  if (width === 0 || height === 0) return null;

  // Logical pixels become screen pixels through zoom, then through the host's
  // own page position. Same order the Spreadsheet's own hit test uses in
  // reverse: `(clientX - rect.left) / zoom`.
  const screenX = hostRect.left + x * zoom;
  const screenY = hostRect.top + y * zoom;

  const visible =
    screenX + width * zoom > hostRect.left &&
    screenX < hostRect.right &&
    screenY + height * zoom > hostRect.top &&
    screenY < hostRect.bottom;
  if (!visible) return null;

  return {
    x: screenX,
    y: screenY,
    width: width * zoom,
    height: height * zoom,
  };
}

/**
 * The rect to hand the overlay: the cell when it can be found, the fixed
 * formula-bar position otherwise.
 */
export function anchorForCell(row: number, col: number): AnchorRect {
  return cellAnchorRect(row, col) ?? FORMULA_BAR_FALLBACK;
}

/** Popover box size, used to keep it inside the window. */
export const POPOVER_WIDTH = 420;
export const POPOVER_MIN_HEIGHT = 220;

/**
 * Turn an anchor into the popover's own top-left, clamped to the viewport.
 *
 * Below the cell by default; above it when there is no room below, because a
 * popover that hangs off the bottom of the screen is a popover with its buttons
 * out of reach.
 */
export function popoverPosition(
  anchor: AnchorRect,
  viewport: { width: number; height: number },
  boxHeight = POPOVER_MIN_HEIGHT,
): { left: number; top: number } {
  const gap = 6;
  let left = anchor.x;
  if (left + POPOVER_WIDTH > viewport.width - 8) {
    left = Math.max(8, viewport.width - POPOVER_WIDTH - 8);
  }
  let top = anchor.y + anchor.height + gap;
  if (top + boxHeight > viewport.height - 8) {
    const above = anchor.y - boxHeight - gap;
    top = above >= 8 ? above : Math.max(8, viewport.height - boxHeight - 8);
  }
  return { left, top };
}
