//FILENAME: app/src/lib/gridRenderer/rendering/grid.ts
//PURPOSE: Grid line and cell background rendering
//CONTEXT: Draws the grid structure and default cell backgrounds
//UPDATED: Added merged cell support - skip internal grid lines for merged regions

import type { RenderState } from "../types";
import { calculateVisibleRange } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";
import { cellKey } from "../../../types";

/**
 * Check if a grid line should be skipped due to a merged cell.
 * For vertical lines: check if the line is inside a horizontally-spanning merged cell.
 * For horizontal lines: check if the line is inside a vertically-spanning merged cell.
 */
function isLineInsideMerge(
  cells: Map<string, { rowSpan?: number; colSpan?: number }>,
  lineType: "vertical" | "horizontal",
  lineIndex: number,
  perpStart: number,
  perpEnd: number
): boolean {
  for (const [key, cell] of cells.entries()) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    
    if (rowSpan <= 1 && colSpan <= 1) continue;
    
    const parts = key.split(",");
    const masterRow = parseInt(parts[0], 10);
    const masterCol = parseInt(parts[1], 10);
    
    if (lineType === "vertical") {
      // Vertical line at column `lineIndex`
      // Skip if line is inside a merged cell's column span
      if (
        colSpan > 1 &&
        lineIndex > masterCol &&
        lineIndex < masterCol + colSpan
      ) {
        // Check if perpendicular range (rows) overlaps with the merge
        const mergeRowEnd = masterRow + rowSpan - 1;
        if (perpEnd >= masterRow && perpStart <= mergeRowEnd) {
          return true;
        }
      }
    } else {
      // Horizontal line at row `lineIndex`
      // Skip if line is inside a merged cell's row span
      if (
        rowSpan > 1 &&
        lineIndex > masterRow &&
        lineIndex < masterRow + rowSpan
      ) {
        // Check if perpendicular range (cols) overlaps with the merge
        const mergeColEnd = masterCol + colSpan - 1;
        if (perpEnd >= masterCol && perpStart <= mergeColEnd) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Get segments of a line that should be drawn, excluding merged cell interiors.
 */
function getLineSegments(
  cells: Map<string, { rowSpan?: number; colSpan?: number }>,
  lineType: "vertical" | "horizontal",
  lineIndex: number,
  perpStart: number,
  perpEnd: number
): Array<{ start: number; end: number }> {
  // Collect all merge regions that intersect this line
  const gaps: Array<{ start: number; end: number }> = [];
  
  for (const [key, cell] of cells.entries()) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    
    if (rowSpan <= 1 && colSpan <= 1) continue;
    
    const parts = key.split(",");
    const masterRow = parseInt(parts[0], 10);
    const masterCol = parseInt(parts[1], 10);
    
    if (lineType === "vertical") {
      // Check if this vertical line is inside a merged cell's column span
      if (
        colSpan > 1 &&
        lineIndex > masterCol &&
        lineIndex < masterCol + colSpan
      ) {
        // Add the row range of this merge as a gap
        gaps.push({ start: masterRow, end: masterRow + rowSpan });
      }
    } else {
      // Check if this horizontal line is inside a merged cell's row span
      if (
        rowSpan > 1 &&
        lineIndex > masterRow &&
        lineIndex < masterRow + rowSpan
      ) {
        // Add the col range of this merge as a gap
        gaps.push({ start: masterCol, end: masterCol + colSpan });
      }
    }
  }
  
  if (gaps.length === 0) {
    return [{ start: perpStart, end: perpEnd + 1 }];
  }
  
  // Sort gaps by start position
  gaps.sort((a, b) => a.start - b.start);
  
  // Build segments by excluding gaps
  const segments: Array<{ start: number; end: number }> = [];
  let current = perpStart;
  
  for (const gap of gaps) {
    if (gap.start > current) {
      segments.push({ start: current, end: gap.start });
    }
    current = Math.max(current, gap.end);
  }
  
  if (current <= perpEnd) {
    segments.push({ start: current, end: perpEnd + 1 });
  }
  
  return segments;
}

/**
 * Draw the grid lines for the cell area.
 * Handles merged cells by not drawing internal grid lines.
 */
export function drawGridLines(state: RenderState): void {
  const { ctx, width, height, config, viewport, theme, dimensions, cells } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;

  const range = calculateVisibleRange(viewport, config, width, height, dimensions);
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  
  // Draw vertical lines with merge-aware gaps
  let x = rowHeaderWidth + range.offsetX;
  for (let col = range.startCol; col <= range.endCol + 1 && col <= totalCols; col++) {
    if (x >= rowHeaderWidth && x <= width) {
      // Get segments that should be drawn (excluding merged cell interiors)
      const segments = getLineSegments(
        cells as Map<string, { rowSpan?: number; colSpan?: number }>,
        "vertical",
        col,
        range.startRow,
        range.endRow
      );
      
      for (const segment of segments) {
        // Calculate Y positions for this segment
        let segmentStartY = colHeaderHeight + range.offsetY;
        for (let r = range.startRow; r < segment.start; r++) {
          segmentStartY += getRowHeight(r, config, dimensions);
        }
        
        let segmentEndY = segmentStartY;
        for (let r = segment.start; r < segment.end && r <= range.endRow; r++) {
          segmentEndY += getRowHeight(r, config, dimensions);
        }
        
        ctx.beginPath();
        ctx.moveTo(Math.floor(x) + 0.5, Math.max(segmentStartY, colHeaderHeight));
        ctx.lineTo(Math.floor(x) + 0.5, Math.min(segmentEndY, height));
        ctx.stroke();
      }
    }
    if (col <= range.endCol) {
      x += getColumnWidth(col, config, dimensions);
    }
  }
  
  // Draw horizontal lines with merge-aware gaps
  let y = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow + 1 && row <= totalRows; row++) {
    if (y >= colHeaderHeight && y <= height) {
      // Get segments that should be drawn (excluding merged cell interiors)
      const segments = getLineSegments(
        cells as Map<string, { rowSpan?: number; colSpan?: number }>,
        "horizontal",
        row,
        range.startCol,
        range.endCol
      );
      
      for (const segment of segments) {
        // Calculate X positions for this segment
        let segmentStartX = rowHeaderWidth + range.offsetX;
        for (let c = range.startCol; c < segment.start; c++) {
          segmentStartX += getColumnWidth(c, config, dimensions);
        }
        
        let segmentEndX = segmentStartX;
        for (let c = segment.start; c < segment.end && c <= range.endCol; c++) {
          segmentEndX += getColumnWidth(c, config, dimensions);
        }
        
        ctx.beginPath();
        ctx.moveTo(Math.max(segmentStartX, rowHeaderWidth), Math.floor(y) + 0.5);
        ctx.lineTo(Math.min(segmentEndX, width), Math.floor(y) + 0.5);
        ctx.stroke();
      }
    }
    if (row <= range.endRow) {
      y += getRowHeight(row, config, dimensions);
    }
  }
}

/**
 * Draw cell backgrounds (for non-default colored cells).
 * Currently draws all visible cells with the default background.
 */
export function drawCellBackgrounds(state: RenderState): void {
  const { ctx, width, height, config, theme } = state;
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  ctx.fillStyle = theme.cellBackground;
  const startX = rowHeaderWidth;
  const startY = colHeaderHeight;
  const areaWidth = width - rowHeaderWidth;
  const areaHeight = height - colHeaderHeight;
  ctx.fillRect(startX, startY, areaWidth, areaHeight);
}