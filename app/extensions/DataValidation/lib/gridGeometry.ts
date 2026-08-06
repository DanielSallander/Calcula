//! FILENAME: app/extensions/DataValidation/lib/gridGeometry.ts
// PURPOSE: Resolve a cell's on-screen rectangle so a click can be tested against
//          the dropdown chevron instead of the whole cell.
// CONTEXT: Cell click interceptors only receive (row, col, clientX, clientY).
//          Turning that client point into a cell-relative point needs the live
//          grid canvas rect + the grid's config/viewport/dimensions/zoom, which
//          extensions reach through the @api facade (never through core).
//
//          The math here MIRRORS the overlay dimension helpers the chevron
//          renderer uses (overlayGetColumnX / overlayGetRowY / ...) on purpose:
//          hit area and painted pixels are then derived from identical inputs,
//          including the two quirks those helpers have (hidden ROWS collapse to
//          zero height; frozen panes are not modelled). Diverging here would put
//          the mouse target somewhere the button is not drawn.

import { getGridStateSnapshot } from "@api/grid";
import { getGridCanvas } from "@api/rendering";
import {
  calculateColumnX,
  calculateRowY,
  createDimensionGetterFromMap,
  getColumnWidth,
  getRowHeight,
} from "@api/dimensions";
import type { Rect } from "./chevronGeometry";
import { isPointInChevron } from "./chevronGeometry";

const DEFAULT_CELL_WIDTH = 100;
const DEFAULT_CELL_HEIGHT = 20;
const DEFAULT_ROW_HEADER_WIDTH = 50;
const DEFAULT_COL_HEADER_HEIGHT = 24;

/**
 * The cell's rectangle in CANVAS logical pixels (the space the grid renderer and
 * the overlay renderers draw in — i.e. before the zoom/DPR transform).
 * Returns null when no grid is mounted.
 */
export function getCellCanvasRect(row: number, col: number): Rect | null {
  const state = getGridStateSnapshot();
  if (!state) return null;

  const { config, viewport, dimensions } = state;
  const defaultWidth = config.defaultCellWidth ?? DEFAULT_CELL_WIDTH;
  const defaultHeight = config.defaultCellHeight ?? DEFAULT_CELL_HEIGHT;
  const hiddenRows = dimensions.hiddenRows;

  const getWidth = createDimensionGetterFromMap(defaultWidth, dimensions.columnWidths);
  const baseGetHeight = createDimensionGetterFromMap(defaultHeight, dimensions.rowHeights);
  const getHeight =
    hiddenRows && hiddenRows.size > 0
      ? (r: number): number => (hiddenRows.has(r) ? 0 : baseGetHeight(r))
      : baseGetHeight;

  return {
    x: calculateColumnX(
      col,
      config.rowHeaderWidth ?? DEFAULT_ROW_HEADER_WIDTH,
      viewport.scrollX,
      getWidth
    ),
    y: calculateRowY(
      row,
      config.colHeaderHeight ?? DEFAULT_COL_HEADER_HEIGHT,
      viewport.scrollY,
      getHeight
    ),
    width: getColumnWidth(col, defaultWidth, dimensions.columnWidths),
    height: hiddenRows?.has(row)
      ? 0
      : getRowHeight(row, defaultHeight, dimensions.rowHeights),
  };
}

/**
 * Convert a client (viewport) point to CANVAS logical pixels.
 * Divides by zoom exactly like the grid's own mouse handling does, because the
 * canvas applies zoom as a context transform, not as a CSS scale.
 * Returns null when no grid canvas is mounted.
 */
export function clientPointToCanvas(
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const canvas = getGridCanvas();
  const state = getGridStateSnapshot();
  if (!canvas || !state) return null;

  const bounds = canvas.getBoundingClientRect();
  const zoom = state.zoom || 1;
  return {
    x: (clientX - bounds.left) / zoom,
    y: (clientY - bounds.top) / zoom,
  };
}

/**
 * The cell's rectangle in CLIENT pixels, for anchoring popups (the dropdown
 * list) directly under the cell. Returns null when no grid is mounted.
 */
export function getCellClientRect(row: number, col: number): Rect | null {
  const cell = getCellCanvasRect(row, col);
  const canvas = getGridCanvas();
  const state = getGridStateSnapshot();
  if (!cell || !canvas || !state) return null;

  const bounds = canvas.getBoundingClientRect();
  const zoom = state.zoom || 1;
  return {
    x: bounds.left + cell.x * zoom,
    y: bounds.top + cell.y * zoom,
    width: cell.width * zoom,
    height: cell.height * zoom,
  };
}

/**
 * True when a click at (clientX, clientY) landed on the dropdown chevron of
 * (row, col). False for a click anywhere else in the cell — that click belongs
 * to the grid's normal selection handling.
 *
 * Fails CLOSED (returns false) when the geometry cannot be resolved: an
 * unresolvable chevron must never cost the user the ability to select the cell.
 */
export function isChevronClick(
  row: number,
  col: number,
  clientX: number,
  clientY: number
): boolean {
  const cell = getCellCanvasRect(row, col);
  if (!cell) return false;
  const point = clientPointToCanvas(clientX, clientY);
  if (!point) return false;
  return isPointInChevron(point.x, point.y, cell);
}
