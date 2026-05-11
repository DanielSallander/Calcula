//! FILENAME: app/src/core/lib/gridRenderer/rendering/spillBorder.ts
// PURPOSE: Render blue solid borders around dynamic array spill ranges
// CONTEXT: Spill ranges are regions where a formula's array result has
//          "spilled" into adjacent cells. Excel shows these with a blue border.

import type { RenderState } from "../types";
import type { FreezeConfig, DimensionOverrides, GridConfig, Viewport } from "../../../types";
import { calculateFreezePaneLayout } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";

/** Excel-style blue for spill borders */
const SPILL_BORDER_COLOR = "#4472C4";

/**
 * Calculate the X position of a column accounting for freeze panes.
 */
function getColumnXWithFreeze(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  viewport: Viewport,
  freezeConfig?: FreezeConfig,
  splitBarSize: number = 0
): number {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const freezeCol = freezeConfig?.freezeCol ?? 0;

  if (freezeCol > 0 && col < freezeCol) {
    let x = rowHeaderWidth;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    return x;
  } else if (freezeCol > 0) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollX = viewport.scrollX || 0;
    let x = rowHeaderWidth + layout.frozenColsWidth + splitBarSize;
    for (let c = freezeCol; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    x -= scrollX;
    return x;
  } else {
    const scrollX = viewport.scrollX || 0;
    let x = rowHeaderWidth;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    return x - scrollX;
  }
}

/**
 * Calculate the Y position of a row accounting for freeze panes.
 */
function getRowYWithFreeze(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  viewport: Viewport,
  freezeConfig?: FreezeConfig,
  splitBarSize: number = 0
): number {
  const colHeaderHeight = config.colHeaderHeight || 24;
  const freezeRow = freezeConfig?.freezeRow ?? 0;

  if (freezeRow > 0 && row < freezeRow) {
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y;
  } else if (freezeRow > 0) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollY = viewport.scrollY || 0;
    let y = colHeaderHeight + layout.frozenRowsHeight + splitBarSize;
    for (let r = freezeRow; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    y -= scrollY;
    return y;
  } else {
    const scrollY = viewport.scrollY || 0;
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y - scrollY;
  }
}

/**
 * Check if any selected cell falls within a spill range.
 */
function selectionOverlapsSpill(
  selection: { startRow: number; startCol: number; endRow: number; endCol: number; additionalRanges?: { startRow: number; startCol: number; endRow: number; endCol: number }[] },
  range: { originRow: number; originCol: number; endRow: number; endCol: number }
): boolean {
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  const overlaps = (r1: number, c1: number, r2: number, c2: number) =>
    r1 <= range.endRow && r2 >= range.originRow &&
    c1 <= range.endCol && c2 >= range.originCol;

  if (overlaps(minRow, minCol, maxRow, maxCol)) return true;

  if (selection.additionalRanges) {
    for (const r of selection.additionalRanges) {
      const rMinRow = Math.min(r.startRow, r.endRow);
      const rMaxRow = Math.max(r.startRow, r.endRow);
      const rMinCol = Math.min(r.startCol, r.endCol);
      const rMaxCol = Math.max(r.startCol, r.endCol);
      if (overlaps(rMinRow, rMinCol, rMaxRow, rMaxCol)) return true;
    }
  }

  return false;
}

/**
 * Draw solid blue borders around spill ranges that overlap with the current selection.
 * Only visible when the user has selected a cell within the spill range.
 */
export function drawSpillBorders(state: RenderState): void {
  const {
    ctx, width, height, config, viewport, dimensions, freezeConfig,
    spillRanges, selection, splitBarSize = 0,
  } = state;

  if (!spillRanges || spillRanges.length === 0 || !selection) {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  for (const range of spillRanges) {
    if (!selectionOverlapsSpill(selection, range)) {
      continue;
    }
    const x1 = getColumnXWithFreeze(range.originCol, config, dimensions, viewport, freezeConfig, splitBarSize);
    const y1 = getRowYWithFreeze(range.originRow, config, dimensions, viewport, freezeConfig, splitBarSize);
    const x2 = getColumnXWithFreeze(range.endCol, config, dimensions, viewport, freezeConfig, splitBarSize) +
               getColumnWidth(range.endCol, config, dimensions);
    const y2 = getRowYWithFreeze(range.endRow, config, dimensions, viewport, freezeConfig, splitBarSize) +
               getRowHeight(range.endRow, config, dimensions);

    // Clip to visible area (past headers)
    const visX1 = Math.max(x1, rowHeaderWidth);
    const visY1 = Math.max(y1, colHeaderHeight);
    const visX2 = Math.min(x2, width);
    const visY2 = Math.min(y2, height);

    if (visX1 >= visX2 || visY1 >= visY2) {
      continue;
    }

    const borderX = visX1 + 0.5;
    const borderY = visY1 + 0.5;
    const borderW = visX2 - visX1 - 1;
    const borderH = visY2 - visY1 - 1;

    if (borderW <= 0 || borderH <= 0) {
      continue;
    }

    // Draw solid blue border (Excel-style)
    ctx.strokeStyle = SPILL_BORDER_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(borderX, borderY, borderW, borderH);
  }
}
