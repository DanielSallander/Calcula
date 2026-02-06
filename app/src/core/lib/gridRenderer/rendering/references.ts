//! FILENAME: app/src/core/lib/gridRenderer/rendering/references.ts
// PURPOSE: Formula reference highlighting
// CONTEXT: Draws colored borders around formula cell references
// FIX: Supports passive (faint) vs active (full) rendering modes

import type { RenderState } from "../types";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight, getColumnX, getRowY } from "../layout/dimensions";

/**
 * Draw formula reference highlights with dotted borders.
 * Passive references (from cell selection) are drawn faintly.
 * Active references (during editing) are drawn with full intensity.
 */
export function drawFormulaReferences(state: RenderState): void {
  const { ctx, width, height, config, viewport, formulaReferences, dimensions } = state;

  if (!formulaReferences || formulaReferences.length === 0) {
    return;
  }
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const range = calculateVisibleRange(viewport, config, width, height, dimensions);
  for (const ref of formulaReferences) {
    // Normalize bounds
    const minRow = Math.min(ref.startRow, ref.endRow);
    const maxRow = Math.max(ref.startRow, ref.endRow);
    const minCol = Math.min(ref.startCol, ref.endCol);
    const maxCol = Math.max(ref.startCol, ref.endCol);
    // Calculate rectangle in viewport coordinates
    const x1 = getColumnX(minCol, config, dimensions, range.startCol, range.offsetX);
    const y1 = getRowY(minRow, config, dimensions, range.startRow, range.offsetY);

    let x2 = x1;
    for (let c = minCol; c <= maxCol; c++) {
      x2 += getColumnWidth(c, config, dimensions);
    }

    let y2 = y1;
    for (let r = minRow; r <= maxRow; r++) {
      y2 += getRowHeight(r, config, dimensions);
    }

    // Clamp to visible area
    const visX1 = Math.max(x1, rowHeaderWidth);
    const visY1 = Math.max(y1, colHeaderHeight);
    const visX2 = Math.min(x2, width);
    const visY2 = Math.min(y2, height);

    // Skip if not visible
    if (visX1 >= visX2 || visY1 >= visY2) {
      continue;
    }

    // FIX: Use different intensity for passive (selection) vs active (editing) references
    const isPassive = ref.isPassive === true;
    const fillOpacity = isPassive ? "0D" : "20";   // 5% vs 12%
    const borderOpacity = isPassive ? "50" : "";    // 31% vs 100%
    const lineWidth = isPassive ? 1 : 2;
    const dashPattern = isPassive ? [6, 4] : [4, 4];

    // Draw semi-transparent fill
    ctx.fillStyle = ref.color + fillOpacity;
    ctx.fillRect(visX1, visY1, visX2 - visX1, visY2 - visY1);

    // Draw dotted border
    ctx.strokeStyle = ref.color + borderOpacity;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashPattern);

    ctx.beginPath();
    ctx.rect(
      Math.max(x1, rowHeaderWidth) + 1,
      Math.max(y1, colHeaderHeight) + 1,
      Math.min(x2 - x1, visX2 - visX1) - 2,
      Math.min(y2 - y1, visY2 - visY1) - 2
    );
    ctx.stroke();

    // Reset line dash
    ctx.setLineDash([]);
  }
}