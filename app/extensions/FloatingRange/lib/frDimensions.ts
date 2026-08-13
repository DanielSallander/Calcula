//! FILENAME: app/extensions/FloatingRange/lib/frDimensions.ts
// PURPOSE: The floating range's OWN row/col size model + frame anatomy math.
// CONTEXT: Frame width/height are DERIVED (counts x sizes + chrome), never
//          stored — the derived-size rule the quantized corner resize depends
//          on. v1 uses uniform defaults (grid defaults 64.29 x 20) with
//          per-col/per-row override maps carried in object state (no UI yet).
//          All coordinates here are LOGICAL pixels (the overlay paint basis).

import type { FloatingRangeEntry } from "./floatingRangeStore";
import {
  FLOATING_RANGE_MAX_ROWS,
  FLOATING_RANGE_MAX_COLS,
} from "@api/floatingRanges";

// ============================================================================
// Frame chrome constants
// ============================================================================

/** Title bar height (the Core-move grab zone). */
export const FR_TITLE_H = 20;
/** Local column-header strip height (A, B, C, …). */
export const FR_COL_HDR_H = 16;
/** Local row-header strip width (1, 2, 3, …). */
export const FR_ROW_HDR_W = 28;

/** Default cell sizes — the grid's own defaults (Excel-parity 64.29 x 20). */
export const FR_DEFAULT_COL_W = 64.29;
export const FR_DEFAULT_ROW_H = 20;

// ============================================================================
// Per-index sizes (override maps with defaults)
// ============================================================================

export function frColWidth(entry: FloatingRangeEntry, col: number): number {
  const w = entry.colWidths[col];
  return typeof w === "number" && isFinite(w) && w > 0 ? w : FR_DEFAULT_COL_W;
}

export function frRowHeight(entry: FloatingRangeEntry, row: number): number {
  const h = entry.rowHeights[row];
  return typeof h === "number" && isFinite(h) && h > 0 ? h : FR_DEFAULT_ROW_H;
}

// ============================================================================
// Derived content + frame sizes
// ============================================================================

/** Total width of the cell area (sum of column widths for the window). */
export function contentWidth(entry: FloatingRangeEntry): number {
  let w = 0;
  for (let c = 0; c < entry.cols; c++) w += frColWidth(entry, c);
  return w;
}

/** Total height of the cell area (sum of row heights for the window). */
export function contentHeight(entry: FloatingRangeEntry): number {
  let h = 0;
  for (let r = 0; r < entry.rows; r++) h += frRowHeight(entry, r);
  return h;
}

/** Derived frame width: local row header + cells. */
export function frameWidth(entry: FloatingRangeEntry): number {
  return FR_ROW_HDR_W + contentWidth(entry);
}

/** Derived frame height: title bar + local col header + cells. */
export function frameHeight(entry: FloatingRangeEntry): number {
  return FR_TITLE_H + FR_COL_HDR_H + contentHeight(entry);
}

/** Frame size for arbitrary counts (resize-ghost math), using this entry's
 *  override maps for indexes it has and defaults beyond them. */
export function frameSizeForCounts(
  entry: FloatingRangeEntry,
  rows: number,
  cols: number,
): { width: number; height: number } {
  let w = FR_ROW_HDR_W;
  for (let c = 0; c < cols; c++) w += frColWidth(entry, c);
  let h = FR_TITLE_H + FR_COL_HDR_H;
  for (let r = 0; r < rows; r++) h += frRowHeight(entry, r);
  return { width: w, height: h };
}

// ============================================================================
// Local cell geometry
// ============================================================================

/** Top-left of a local cell, relative to the FRAME origin (logical px). */
export function localCellOrigin(
  entry: FloatingRangeEntry,
  row: number,
  col: number,
): { x: number; y: number } {
  let x = FR_ROW_HDR_W;
  for (let c = 0; c < col; c++) x += frColWidth(entry, c);
  let y = FR_TITLE_H + FR_COL_HDR_H;
  for (let r = 0; r < row; r++) y += frRowHeight(entry, r);
  return { x, y };
}

/** Which zone of the frame a point (relative to the frame origin) is in. */
export type FrHitZone =
  | { zone: "outside" }
  | { zone: "title" }
  | { zone: "colHeader"; col: number }
  | { zone: "rowHeader"; row: number }
  | { zone: "cells"; row: number; col: number };

/**
 * Map a frame-relative point to a zone + local cell. A linear walk — fine at
 * v1 scale (windows are bounded at 1000 x 256 and typically tiny).
 */
export function localCellFromPoint(
  entry: FloatingRangeEntry,
  dx: number,
  dy: number,
): FrHitZone {
  if (dx < 0 || dy < 0 || dx > frameWidth(entry) || dy > frameHeight(entry)) {
    return { zone: "outside" };
  }
  if (dy < FR_TITLE_H) return { zone: "title" };

  // Column from x (points in the local row-header gutter clamp to col 0's edge).
  const colX = dx - FR_ROW_HDR_W;
  let col = 0;
  if (colX >= 0) {
    let acc = 0;
    for (let c = 0; c < entry.cols; c++) {
      acc += frColWidth(entry, c);
      if (colX < acc) {
        col = c;
        break;
      }
      col = c; // clamp to the last column when past the end
    }
  }

  if (dy < FR_TITLE_H + FR_COL_HDR_H) {
    if (colX < 0) return { zone: "title" }; // top-left corner box: treat as chrome
    return { zone: "colHeader", col };
  }

  // Row from y.
  const rowY = dy - FR_TITLE_H - FR_COL_HDR_H;
  let row = 0;
  let acc = 0;
  for (let r = 0; r < entry.rows; r++) {
    acc += frRowHeight(entry, r);
    if (rowY < acc) {
      row = r;
      break;
    }
    row = r; // clamp to the last row when past the end
  }

  if (colX < 0) return { zone: "rowHeader", row };
  return { zone: "cells", row, col };
}

// ============================================================================
// Quantized resize: rect size -> best whole counts
// ============================================================================

/**
 * Convert a dragged frame width/height into the best-matching whole row/col
 * counts: walk sizes and pick the count whose cumulative extent is nearest the
 * target (at least 1; clamped to the backend bounds). Raw w/h is NEVER
 * persisted — this is the ONLY interpretation of a corner drag.
 */
export function bestCountsForSize(
  entry: FloatingRangeEntry,
  width: number,
  height: number,
): { rows: number; cols: number } {
  const targetW = width - FR_ROW_HDR_W;
  const targetH = height - FR_TITLE_H - FR_COL_HDR_H;

  let cols = 1;
  {
    let acc = frColWidth(entry, 0);
    let best = Math.abs(acc - targetW);
    for (let c = 2; c <= FLOATING_RANGE_MAX_COLS; c++) {
      acc += frColWidth(entry, c - 1);
      const d = Math.abs(acc - targetW);
      if (d < best) {
        best = d;
        cols = c;
      }
      if (acc > targetW) break; // sums only grow; no better fit past the target
    }
  }

  let rows = 1;
  {
    let acc = frRowHeight(entry, 0);
    let best = Math.abs(acc - targetH);
    for (let r = 2; r <= FLOATING_RANGE_MAX_ROWS; r++) {
      acc += frRowHeight(entry, r - 1);
      const d = Math.abs(acc - targetH);
      if (d < best) {
        best = d;
        rows = r;
      }
      if (acc > targetH) break;
    }
  }

  return { rows, cols };
}
