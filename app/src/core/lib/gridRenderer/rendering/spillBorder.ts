//! FILENAME: app/src/core/lib/gridRenderer/rendering/spillBorder.ts
// PURPOSE: Render blue dashed borders around dynamic array spill ranges
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
  freezeConfig?: FreezeConfig
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
    let x = rowHeaderWidth + layout.frozenColsWidth;
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
  freezeConfig?: FreezeConfig
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
    let y = colHeaderHeight + layout.frozenRowsHeight;
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
 * Draw blue dashed borders around all spill ranges visible on the grid.
 * Called after selection drawing so the spill borders appear above cell content
 * but don't interfere with active selection visuals.
 */
export function drawSpillBorders(state: RenderState): void {
  const {
    ctx, width, height, config, viewport, dimensions, freezeConfig,
    spillRanges,
  } = state;

  if (!spillRanges || spillRanges.length === 0) {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  for (const range of spillRanges) {
    const x1 = getColumnXWithFreeze(range.originCol, config, dimensions, viewport, freezeConfig);
    const y1 = getRowYWithFreeze(range.originRow, config, dimensions, viewport, freezeConfig);
    const x2 = getColumnXWithFreeze(range.endCol, config, dimensions, viewport, freezeConfig) +
               getColumnWidth(range.endCol, config, dimensions);
    const y2 = getRowYWithFreeze(range.endRow, config, dimensions, viewport, freezeConfig) +
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

    // Draw blue dashed border
    ctx.strokeStyle = SPILL_BORDER_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(borderX, borderY, borderW, borderH);
    ctx.setLineDash([]);
  }
}
