// FILENAME: app/src/core/lib/gridRenderer/core.ts
// PURPOSE: Main rendering orchestration function
// CONTEXT: Coordinates all rendering phases for the grid
// UPDATED: Fixed freeze pane cell text rendering with proper padding
// UPDATED: Added merged cell support for freeze pane zone rendering

import type {
  GridConfig,
  Viewport,
  Selection,
  EditingCell,
  CellDataMap,
  FormulaReference,
  DimensionOverrides,
  StyleDataMap,
  ClipboardMode,
  InsertionAnimation,
  FreezeConfig,
  VisibleRange,
} from "../../../core/types";
import type { GridTheme, RenderState } from "./types";
import { DEFAULT_THEME } from "./types";
import { drawCorner, drawColumnHeaders, drawRowHeaders } from "./rendering/headers";
import { drawGridLines } from "./rendering/grid";
import { drawCellText } from "./rendering/cells";
import { drawSelection, drawFillPreview, drawClipboardSelection } from "./rendering/selection";
import { drawFormulaReferences } from "./rendering/references";
import { 
  calculateVisibleRange, 
  calculateFreezePaneLayout,
  calculateFrozenTopLeftRange,
  calculateFrozenTopRange,
  calculateFrozenLeftRange,
  calculateScrollableRange,
} from "./layout/viewport";
import { getColumnWidth, getRowHeight } from "./layout/dimensions";
import { cellKey } from "../../../core/types";
import type { PivotRegionData } from "../../../core/types";

/**
 * Check if a cell is a "slave" cell (part of a merge but not the master).
 * Returns the master cell's key if it is, null otherwise.
 */
function getMasterCellKey(
  row: number,
  col: number,
  cells: Map<string, { rowSpan?: number; colSpan?: number }>
): string | null {
  for (const [key, cell] of cells.entries()) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    
    if (rowSpan > 1 || colSpan > 1) {
      const parts = key.split(",");
      const masterRow = parseInt(parts[0], 10);
      const masterCol = parseInt(parts[1], 10);
      
      if (
        row >= masterRow &&
        row < masterRow + rowSpan &&
        col >= masterCol &&
        col < masterCol + colSpan &&
        !(row === masterRow && col === masterCol)
      ) {
        return key;
      }
    }
  }
  return null;
}

/**
 * Calculate the total width of a merged cell spanning multiple columns.
 */
function getMergedCellWidth(
  startCol: number,
  colSpan: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  let totalWidth = 0;
  for (let c = startCol; c < startCol + colSpan; c++) {
    totalWidth += getColumnWidth(c, config, dimensions);
  }
  return totalWidth;
}

/**
 * Calculate the total height of a merged cell spanning multiple rows.
 */
function getMergedCellHeight(
  startRow: number,
  rowSpan: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  let totalHeight = 0;
  for (let r = startRow; r < startRow + rowSpan; r++) {
    totalHeight += getRowHeight(r, config, dimensions);
  }
  return totalHeight;
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
  const gaps: Array<{ start: number; end: number }> = [];
  
  for (const [key, cell] of cells.entries()) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    
    if (rowSpan <= 1 && colSpan <= 1) continue;
    
    const parts = key.split(",");
    const masterRow = parseInt(parts[0], 10);
    const masterCol = parseInt(parts[1], 10);
    
    if (lineType === "vertical") {
      if (
        colSpan > 1 &&
        lineIndex > masterCol &&
        lineIndex < masterCol + colSpan
      ) {
        gaps.push({ start: masterRow, end: masterRow + rowSpan });
      }
    } else {
      if (
        rowSpan > 1 &&
        lineIndex > masterRow &&
        lineIndex < masterRow + rowSpan
      ) {
        gaps.push({ start: masterCol, end: masterCol + colSpan });
      }
    }
  }
  
  if (gaps.length === 0) {
    return [{ start: perpStart, end: perpEnd + 1 }];
  }
  
  gaps.sort((a, b) => a.start - b.start);
  
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
 * Render a single zone of the grid with clipping.
 */
function renderZone(
  state: RenderState,
  range: VisibleRange,
  clipX: number,
  clipY: number,
  clipWidth: number,
  clipHeight: number
): void {
  const { ctx, theme } = state;
  
  // Save context state
  ctx.save();
  
  // Set clipping region for this zone
  ctx.beginPath();
  ctx.rect(clipX, clipY, clipWidth, clipHeight);
  ctx.clip();
  
  // Clear zone background
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(clipX, clipY, clipWidth, clipHeight);
  
  // Draw grid lines for this zone
  drawGridLinesZone(state, range, clipX, clipY, clipWidth, clipHeight);
  
  // Draw cell text for this zone
  drawCellTextZone(state, range, clipX, clipY, clipWidth, clipHeight);
  
  // Restore context state
  ctx.restore();
}

/**
 * Draw grid lines for a specific zone with merge-aware gaps.
 */
function drawGridLinesZone(
  state: RenderState,
  range: VisibleRange,
  clipX: number,
  clipY: number,
  clipWidth: number,
  clipHeight: number
): void {
  const { ctx, config, theme, dimensions, cells } = state;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;
  
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  
  // Draw vertical lines with merge-aware gaps
  let x = clipX + range.offsetX;
  for (let col = range.startCol; col <= range.endCol + 1 && col <= totalCols; col++) {
    if (x >= clipX && x <= clipX + clipWidth) {
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
        let segmentStartY = clipY + range.offsetY;
        for (let r = range.startRow; r < segment.start; r++) {
          segmentStartY += getRowHeight(r, config, dimensions);
        }
        
        let segmentEndY = segmentStartY;
        for (let r = segment.start; r < segment.end && r <= range.endRow; r++) {
          segmentEndY += getRowHeight(r, config, dimensions);
        }
        
        ctx.beginPath();
        ctx.moveTo(Math.floor(x) + 0.5, Math.max(segmentStartY, clipY));
        ctx.lineTo(Math.floor(x) + 0.5, Math.min(segmentEndY, clipY + clipHeight));
        ctx.stroke();
      }
    }
    if (col <= range.endCol) {
      const colWidth = getColumnWidth(col, config, dimensions);
      x += colWidth;
    }
  }
  
  // Draw horizontal lines with merge-aware gaps
  let y = clipY + range.offsetY;
  for (let row = range.startRow; row <= range.endRow + 1 && row <= totalRows; row++) {
    if (y >= clipY && y <= clipY + clipHeight) {
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
        let segmentStartX = clipX + range.offsetX;
        for (let c = range.startCol; c < segment.start; c++) {
          segmentStartX += getColumnWidth(c, config, dimensions);
        }
        
        let segmentEndX = segmentStartX;
        for (let c = segment.start; c < segment.end && c <= range.endCol; c++) {
          segmentEndX += getColumnWidth(c, config, dimensions);
        }
        
        ctx.beginPath();
        ctx.moveTo(Math.max(segmentStartX, clipX), Math.floor(y) + 0.5);
        ctx.lineTo(Math.min(segmentEndX, clipX + clipWidth), Math.floor(y) + 0.5);
        ctx.stroke();
      }
    }
    if (row <= range.endRow) {
      const rowHeight = getRowHeight(row, config, dimensions);
      y += rowHeight;
    }
  }
}

/**
 * Draw cell text for a specific zone with merged cell support.
 * Uses the same padding and bounds logic as the main drawCellText function.
 */
function drawCellTextZone(
  state: RenderState,
  range: VisibleRange,
  clipX: number,
  clipY: number,
  clipWidth: number,
  clipHeight: number
): void {
  const { ctx, config, theme, cells, editing, dimensions, styleCache } = state;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;
  const paddingX = 4;
  
  // Calculate zone boundaries for clipping
  const zoneLeft = clipX;
  const zoneTop = clipY;
  const zoneRight = clipX + clipWidth;
  const zoneBottom = clipY + clipHeight;
  
  // Track which cells we've already drawn (to avoid drawing slave cells)
  const drawnCells = new Set<string>();
  
  let baseY = clipY + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dimensions);
    
    let baseX = clipX + range.offsetX;
    for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
      const colWidth = getColumnWidth(col, config, dimensions);
      const key = cellKey(row, col);
      
      // Skip if already drawn (slave cells)
      if (drawnCells.has(key)) {
        baseX += colWidth;
        continue;
      }
      
      // Check if this cell is a slave (part of another cell's merge)
      const masterKey = getMasterCellKey(row, col, cells as Map<string, { rowSpan?: number; colSpan?: number }>);
      if (masterKey) {
        // This is a slave cell - skip rendering
        drawnCells.add(key);
        baseX += colWidth;
        continue;
      }
      
      // Skip if this cell is being edited
      if (editing && editing.row === row && editing.col === col) {
        baseX += colWidth;
        continue;
      }
      
      // Look up cell data
      const cell = cells.get(key);
      
      if (!cell || cell.display === "") {
        baseX += colWidth;
        continue;
      }
      
      // Get merge spans
      const rowSpan = (cell as { rowSpan?: number }).rowSpan ?? 1;
      const colSpan = (cell as { colSpan?: number }).colSpan ?? 1;
      
      // Calculate actual cell dimensions (may span multiple cells)
      const actualWidth = colSpan > 1 
        ? getMergedCellWidth(col, colSpan, config, dimensions)
        : colWidth;
      const actualHeight = rowSpan > 1
        ? getMergedCellHeight(row, rowSpan, config, dimensions)
        : rowHeight;
      
      // Mark all cells in the merge region as drawn
      if (rowSpan > 1 || colSpan > 1) {
        for (let r = row; r < row + rowSpan; r++) {
          for (let c = col; c < col + colSpan; c++) {
            drawnCells.add(cellKey(r, c));
          }
        }
      }
      
      // Calculate visible cell bounds (clipped to zone)
      const cellLeft = Math.max(baseX, zoneLeft);
      const cellTop = Math.max(baseY, zoneTop);
      const cellRight = Math.min(baseX + actualWidth, zoneRight);
      const cellBottom = Math.min(baseY + actualHeight, zoneBottom);
      
      // Skip if cell is not visible
      if (cellRight <= cellLeft || cellBottom <= cellTop) {
        baseX += colWidth;
        continue;
      }
      
      // Calculate available width for text
      const availableWidth = cellRight - cellLeft - paddingX * 2;
      
      if (availableWidth <= 0) {
        baseX += colWidth;
        continue;
      }
      
      // Get style
      const styleIndex = cell.styleIndex ?? 0;
      const cellStyle = styleCache.get(styleIndex) ?? styleCache.get(0);
      
      // Set up clipping region for this cell
      ctx.save();
      ctx.beginPath();
      ctx.rect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      ctx.clip();
      
      // Draw background if style has non-default background
      if (cellStyle && cellStyle.backgroundColor && 
          cellStyle.backgroundColor !== "#ffffff" && 
          cellStyle.backgroundColor !== "#FFFFFF" &&
          cellStyle.backgroundColor !== "transparent") {
        ctx.fillStyle = cellStyle.backgroundColor;
        ctx.fillRect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      }
      
      // Build font string
      const fontWeight = cellStyle?.bold ? "bold" : "normal";
      const fontStyle = cellStyle?.italic ? "italic" : "normal";
      const fontSize = cellStyle?.fontSize ?? theme.cellFontSize;
      const fontFamily = cellStyle?.fontFamily ?? theme.cellFontFamily;
      
      ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = cellStyle?.textColor ?? theme.cellText;
      ctx.textBaseline = "middle";
      
      // Calculate text position with proper padding
      // Center vertically in the full merged cell height
      const textX = cellLeft + paddingX;
      const textY = baseY + actualHeight / 2;
      
      // Determine text alignment
      let textAlign: "left" | "right" | "center" = "left";
      if (cellStyle?.textAlign === "right") {
        textAlign = "right";
      } else if (cellStyle?.textAlign === "center") {
        textAlign = "center";
      } else if (cellStyle?.textAlign === "general" || !cellStyle?.textAlign) {
        // Check if numeric for right alignment
        const numericPattern = /^-?[\d,]+\.?\d*%?$|^-?\.\d+%?$/;
        if (numericPattern.test(cell.display.trim())) {
          textAlign = "right";
        }
      }
      
      // Draw text with alignment
      ctx.textAlign = "left";
      let drawX = textX;
      const textMetrics = ctx.measureText(cell.display);
      const textWidth = Math.min(textMetrics.width, availableWidth);
      
      if (textAlign === "right") {
        drawX = cellLeft + (cellRight - cellLeft) - paddingX - textWidth;
      } else if (textAlign === "center") {
        drawX = cellLeft + ((cellRight - cellLeft) - textWidth) / 2;
      }
      
      ctx.fillText(cell.display, drawX, textY, availableWidth);
      
      // Draw underline if needed
      if (cellStyle?.underline) {
        ctx.beginPath();
        ctx.strokeStyle = cellStyle?.textColor ?? theme.cellText;
        ctx.lineWidth = 1;
        ctx.moveTo(drawX, textY + fontSize / 2 + 1);
        ctx.lineTo(drawX + textWidth, textY + fontSize / 2 + 1);
        ctx.stroke();
      }
      
      // Draw strikethrough if needed
      if (cellStyle?.strikethrough) {
        ctx.beginPath();
        ctx.strokeStyle = cellStyle?.textColor ?? theme.cellText;
        ctx.lineWidth = 1;
        ctx.moveTo(drawX, textY);
        ctx.lineTo(drawX + textWidth, textY);
        ctx.stroke();
      }
      
      ctx.restore();
      
      baseX += colWidth;
    }
    baseY += rowHeight;
  }
}

/**
 * Draw pivot table placeholder for empty pivot regions.
 * Shows a white rectangle with a light border to indicate the reserved area.
 */
function drawPivotPlaceholder(
  ctx: CanvasRenderingContext2D,
  region: PivotRegionData,
  config: GridConfig,
  viewport: Viewport,
  dimensions: DimensionOverrides
): void {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  
  // Calculate pixel positions for the region
  let startX = rowHeaderWidth;
  for (let col = 0; col < region.startCol; col++) {
    startX += getColumnWidth(col, config, dimensions);
  }
  startX -= viewport.scrollX;
  
  let startY = colHeaderHeight;
  for (let row = 0; row < region.startRow; row++) {
    startY += getRowHeight(row, config, dimensions);
  }
  startY -= viewport.scrollY;
  
  // Calculate width and height of the region
  let regionWidth = 0;
  for (let col = region.startCol; col <= region.endCol; col++) {
    regionWidth += getColumnWidth(col, config, dimensions);
  }
  
  let regionHeight = 0;
  for (let row = region.startRow; row <= region.endRow; row++) {
    regionHeight += getRowHeight(row, config, dimensions);
  }
  
  // Only draw if visible
  if (startX + regionWidth < rowHeaderWidth || startY + regionHeight < colHeaderHeight) {
    return;
  }
  
  // Clip to cell area (not headers)
  ctx.save();
  ctx.beginPath();
  ctx.rect(rowHeaderWidth, colHeaderHeight, ctx.canvas.width / (window.devicePixelRatio || 1) - rowHeaderWidth, ctx.canvas.height / (window.devicePixelRatio || 1) - colHeaderHeight);
  ctx.clip();
  
  // Draw white background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(startX, startY, regionWidth, regionHeight);
  
  // Draw light gray border
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(startX) + 0.5,
    Math.floor(startY) + 0.5,
    regionWidth - 1,
    regionHeight - 1
  );
  
  // Draw "PivotTable" text in center (like Excel's placeholder)
  ctx.fillStyle = "#888888";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  
  const centerX = startX + regionWidth / 2;
  const centerY = startY + regionHeight / 2;
  
  // Only draw text if there's enough space
  if (regionWidth > 80 && regionHeight > 30) {
    ctx.fillText("PivotTable", centerX, centerY - 8);
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("Drag fields to build", centerX, centerY + 8);
  }
  
  ctx.restore();
}

/**
 * Main render function for the grid.
 * Orchestrates all rendering phases in the correct order.
 * Supports freeze panes with 4-zone rendering.
 */
export function renderGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: GridConfig,
  viewport: Viewport,
  selection: Selection | null,
  editing: EditingCell | null,
  cells: CellDataMap,
  theme: GridTheme = DEFAULT_THEME,
  formulaReferences: FormulaReference[] = [],
  dimensions?: DimensionOverrides,
  styleCache?: StyleDataMap,
  fillPreviewRange?: Selection | null,
  clipboardSelection?: Selection | null,
  clipboardMode?: ClipboardMode,
  clipboardAnimationOffset?: number,
  insertionAnimation?: InsertionAnimation | null,
  freezeConfig?: FreezeConfig,
  pivotRegions?: PivotRegionData[]  // Add this parameter
): void {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  
  const dims = dimensions || {
    columnWidths: new Map(),
    rowHeights: new Map(),
  };
  
  const styles = styleCache || new Map();
  
  // Create base render state
  const state: RenderState = {
    ctx,
    width,
    height,
    config,
    viewport,
    selection,
    editing,
    theme,
    cells,
    formulaReferences,
    dimensions: dims,
    styleCache: styles,
    fillPreviewRange: fillPreviewRange || null,
    clipboardSelection: clipboardSelection || null,
    clipboardMode: clipboardMode || "none",
    clipboardAnimationOffset: clipboardAnimationOffset || 0,
    insertionAnimation: insertionAnimation || undefined,
    freezeConfig: freezeConfig || { freezeRow: null, freezeCol: null },
  };

  // Clear canvas
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(0, 0, width, height);

  // Check if we have freeze panes
  const hasFreezeRows = freezeConfig && freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0;
  const hasFreezeCols = freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;
  
  if (hasFreezeRows || hasFreezeCols) {
    // Render with freeze panes (4 zones)
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dims);
    
    // Calculate zone boundaries
    const frozenColsX = rowHeaderWidth;
    const frozenRowsY = colHeaderHeight;
    const scrollableX = rowHeaderWidth + layout.frozenColsWidth;
    const scrollableY = colHeaderHeight + layout.frozenRowsHeight;
    const scrollableWidth = width - scrollableX;
    const scrollableHeight = height - scrollableY;
    
    // 1. Render bottom-right (main scrollable) zone first
    const scrollableRange = calculateScrollableRange(viewport, freezeConfig!, config, width, height, dims);
    if (scrollableWidth > 0 && scrollableHeight > 0) {
      renderZone(state, scrollableRange, scrollableX, scrollableY, scrollableWidth, scrollableHeight);
    }
    
    // 2. Render bottom-left (frozen columns) zone
    if (hasFreezeCols) {
      const leftRange = calculateFrozenLeftRange(viewport, freezeConfig!, config, width, height, dims);
      if (leftRange && scrollableHeight > 0) {
        renderZone(state, leftRange, frozenColsX, scrollableY, layout.frozenColsWidth, scrollableHeight);
      }
    }
    
    // 3. Render top-right (frozen rows) zone
    if (hasFreezeRows) {
      const topRange = calculateFrozenTopRange(viewport, freezeConfig!, config, width, height, dims);
      if (topRange && scrollableWidth > 0) {
        renderZone(state, topRange, scrollableX, frozenRowsY, scrollableWidth, layout.frozenRowsHeight);
      }
    }
    
    // 4. Render top-left (frozen corner) zone
    if (hasFreezeRows && hasFreezeCols) {
      const topLeftRange = calculateFrozenTopLeftRange(freezeConfig!, config, width, height, dims);
      if (topLeftRange) {
        renderZone(state, topLeftRange, frozenColsX, frozenRowsY, layout.frozenColsWidth, layout.frozenRowsHeight);
      }
    }
    
    // Draw freeze pane separator lines
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;
    
    if (hasFreezeCols && layout.frozenColsWidth > 0) {
      ctx.beginPath();
      ctx.moveTo(scrollableX, colHeaderHeight);
      ctx.lineTo(scrollableX, height);
      ctx.stroke();
    }
    
    if (hasFreezeRows && layout.frozenRowsHeight > 0) {
      ctx.beginPath();
      ctx.moveTo(rowHeaderWidth, scrollableY);
      ctx.lineTo(width, scrollableY);
      ctx.stroke();
    }
    
  } else {
    // Standard rendering without freeze panes
    // 1. Grid lines (background)
    drawGridLines(state);

    // 2. Cells (content)
    drawCellText(state);
  }

  // 2.5. Draw pivot placeholders for empty pivot regions
  if (pivotRegions && pivotRegions.length > 0) {
    for (const region of pivotRegions) {
      if (region.isEmpty) {
        drawPivotPlaceholder(ctx, region, config, viewport, dims);
      }
    }
  }

  // 3. Formula references (before selection so selection appears on top)
  if (formulaReferences.length > 0) {
    drawFormulaReferences(state);
  }

  // 4. Fill preview (if dragging fill handle)
  if (fillPreviewRange) {
    drawFillPreview(state);
  }

  // 5. Selection (highlight layer)
  if (selection) {
    drawSelection(state);
  }

  // 6. Clipboard selection (marching ants for copy/cut)
  if (clipboardSelection && clipboardMode && clipboardMode !== "none") {
    drawClipboardSelection(state);
  }

  // 7. Headers (overlay, drawn last so they appear on top)
  drawColumnHeaders(state);
  drawRowHeaders(state);

  // 8. Corner cell (top-left intersection)
  drawCorner(state);
}