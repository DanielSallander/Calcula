//! FILENAME: app/src/core/lib/gridRenderer/rendering/spillBorder.ts
// PURPOSE: Render blue solid borders around dynamic array spill ranges
// CONTEXT: Spill ranges are regions where a formula's array result has
//          "spilled" into adjacent cells. Excel shows these with a blue border.

import type { RenderState } from "../types";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
// The freeze-aware geometry lives in ONE place, shared with the @api
// rangeToCanvasRect helper (@api/gridLayers) that extensions draw range
// outlines with.
import { columnXWithFreeze as getColumnXWithFreeze, rowYWithFreeze as getRowYWithFreeze } from "../layout/rangeRect";
import { rowHeaderGutter, colHeaderGutter } from "../layout/headerVisibility";

/** Excel-style blue for spill borders */
const SPILL_BORDER_COLOR = "#4472C4";

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

  const rowHeaderWidth = rowHeaderGutter(config);
  const colHeaderHeight = colHeaderGutter(config);

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
