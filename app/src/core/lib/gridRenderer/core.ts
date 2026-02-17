//! FILENAME: app/src/core/lib/gridRenderer/core.ts
// PURPOSE: Main rendering orchestration function
// CONTEXT: Coordinates all rendering phases for the grid
// FIX: Removed API import - overlays are now passed as parameters

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
import { drawSelection, drawFillPreview, drawClipboardSelection, drawSelectionDragPreview } from "./rendering/selection";
import { drawFormulaReferences } from "./rendering/references";
import {
  calculateFreezePaneLayout,
  calculateFrozenTopLeftRange,
  calculateFrozenTopRange,
  calculateFrozenLeftRange,
  calculateScrollableRange,
} from "./layout/viewport";
import { getColumnWidth, getRowHeight } from "./layout/dimensions";
import { cellKey } from "../../../core/types";

// REMOVED: import { getGridRegions, getOverlayRenderers } from "../../../api/gridOverlays";

// ============================================================================
// Overlay Types (defined locally in Core for type safety)
// ============================================================================

/** A rectangular region on the grid that an extension claims ownership of. */
export interface GridRegion {
  id: string;
  type: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  data?: Record<string, unknown>;
  /** Pixel-based positioning for free-floating overlays. */
  floating?: { x: number; y: number; width: number; height: number };
}

/** Context passed to overlay render functions during grid paint. */
export interface OverlayRenderContext {
  ctx: CanvasRenderingContext2D;
  region: GridRegion;
  config: GridConfig;
  viewport: Viewport;
  dimensions: DimensionOverrides;
  canvasWidth: number;
  canvasHeight: number;
}

/** A function that renders an overlay for a given region. */
export type OverlayRendererFn = (context: OverlayRenderContext) => void;

/** Describes an overlay renderer that handles a specific region type. */
export interface OverlayRegistration {
  type: string;
  render: OverlayRendererFn;
  priority?: number;
}

// ============================================================================
// Helper Functions (unchanged)
// ============================================================================

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

function renderZone(
  state: RenderState,
  range: VisibleRange,
  clipX: number,
  clipY: number,
  clipWidth: number,
  clipHeight: number
): void {
  const { ctx, theme } = state;
  
  ctx.save();
  ctx.beginPath();
  ctx.rect(clipX, clipY, clipWidth, clipHeight);
  ctx.clip();
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(clipX, clipY, clipWidth, clipHeight);
  drawGridLinesZone(state, range, clipX, clipY, clipWidth, clipHeight);
  drawCellTextZone(state, range, clipX, clipY, clipWidth, clipHeight);
  ctx.restore();
}

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
  
  let x = clipX + range.offsetX;
  for (let col = range.startCol; col <= range.endCol + 1 && col <= totalCols; col++) {
    if (x >= clipX && x <= clipX + clipWidth) {
      const segments = getLineSegments(
        cells as Map<string, { rowSpan?: number; colSpan?: number }>,
        "vertical",
        col,
        range.startRow,
        range.endRow
      );
      
      for (const segment of segments) {
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
  
  let y = clipY + range.offsetY;
  for (let row = range.startRow; row <= range.endRow + 1 && row <= totalRows; row++) {
    if (y >= clipY && y <= clipY + clipHeight) {
      const segments = getLineSegments(
        cells as Map<string, { rowSpan?: number; colSpan?: number }>,
        "horizontal",
        row,
        range.startCol,
        range.endCol
      );
      
      for (const segment of segments) {
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
  
  const zoneLeft = clipX;
  const zoneTop = clipY;
  const zoneRight = clipX + clipWidth;
  const zoneBottom = clipY + clipHeight;
  
  const drawnCells = new Set<string>();
  
  let baseY = clipY + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dimensions);
    
    let baseX = clipX + range.offsetX;
    for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
      const colWidth = getColumnWidth(col, config, dimensions);
      const key = cellKey(row, col);
      
      if (drawnCells.has(key)) {
        baseX += colWidth;
        continue;
      }
      
      const masterKey = getMasterCellKey(row, col, cells as Map<string, { rowSpan?: number; colSpan?: number }>);
      if (masterKey) {
        drawnCells.add(key);
        baseX += colWidth;
        continue;
      }
      
      if (editing && editing.row === row && editing.col === col) {
        baseX += colWidth;
        continue;
      }
      
      const cell = cells.get(key);
      
      if (!cell || cell.display === "") {
        baseX += colWidth;
        continue;
      }
      
      const rowSpan = (cell as { rowSpan?: number }).rowSpan ?? 1;
      const colSpan = (cell as { colSpan?: number }).colSpan ?? 1;
      
      const actualWidth = colSpan > 1 
        ? getMergedCellWidth(col, colSpan, config, dimensions)
        : colWidth;
      const actualHeight = rowSpan > 1
        ? getMergedCellHeight(row, rowSpan, config, dimensions)
        : rowHeight;
      
      if (rowSpan > 1 || colSpan > 1) {
        for (let r = row; r < row + rowSpan; r++) {
          for (let c = col; c < col + colSpan; c++) {
            drawnCells.add(cellKey(r, c));
          }
        }
      }
      
      const cellLeft = Math.max(baseX, zoneLeft);
      const cellTop = Math.max(baseY, zoneTop);
      const cellRight = Math.min(baseX + actualWidth, zoneRight);
      const cellBottom = Math.min(baseY + actualHeight, zoneBottom);
      
      if (cellRight <= cellLeft || cellBottom <= cellTop) {
        baseX += colWidth;
        continue;
      }
      
      const availableWidth = cellRight - cellLeft - paddingX * 2;
      
      if (availableWidth <= 0) {
        baseX += colWidth;
        continue;
      }
      
      const styleIndex = cell.styleIndex ?? 0;
      const cellStyle = styleCache.get(styleIndex) ?? styleCache.get(0);
      
      ctx.save();
      ctx.beginPath();
      ctx.rect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      ctx.clip();
      
      if (cellStyle && cellStyle.backgroundColor && 
          cellStyle.backgroundColor !== "#ffffff" && 
          cellStyle.backgroundColor !== "#FFFFFF" &&
          cellStyle.backgroundColor !== "transparent") {
        ctx.fillStyle = cellStyle.backgroundColor;
        ctx.fillRect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
      }
      
      const fontWeight = cellStyle?.bold ? "bold" : "normal";
      const fontStyle = cellStyle?.italic ? "italic" : "normal";
      const fontSize = cellStyle?.fontSize ?? theme.cellFontSize;
      const fontFamily = cellStyle?.fontFamily ?? theme.cellFontFamily;
      
      ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = cellStyle?.textColor ?? theme.cellText;
      ctx.textBaseline = "middle";
      
      const textX = cellLeft + paddingX;
      const textY = baseY + actualHeight / 2;
      
      let textAlign: "left" | "right" | "center" = "left";
      if (cellStyle?.textAlign === "right") {
        textAlign = "right";
      } else if (cellStyle?.textAlign === "center") {
        textAlign = "center";
      } else if (cellStyle?.textAlign === "general" || !cellStyle?.textAlign) {
        const numericPattern = /^-?[\d,]+\.?\d*%?$|^-?\.\d+%?$/;
        if (numericPattern.test(cell.display.trim())) {
          textAlign = "right";
        }
      }
      
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
      
      if (cellStyle?.underline) {
        ctx.beginPath();
        ctx.strokeStyle = cellStyle?.textColor ?? theme.cellText;
        ctx.lineWidth = 1;
        ctx.moveTo(drawX, textY + fontSize / 2 + 1);
        ctx.lineTo(drawX + textWidth, textY + fontSize / 2 + 1);
        ctx.stroke();
      }
      
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

// ============================================================================
// Main Render Function
// ============================================================================

/**
 * Main render function for the grid.
 * Orchestrates all rendering phases in the correct order.
 * 
 * @param overlayRegions - Grid regions provided by the Shell (from extensions)
 * @param overlayRenderers - Overlay renderers provided by the Shell (from extensions)
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
  selectionDragPreview?: Selection | null,
  clipboardSelection?: Selection | null,
  clipboardMode?: ClipboardMode,
  clipboardAnimationOffset?: number,
  insertionAnimation?: InsertionAnimation | null,
  freezeConfig?: FreezeConfig,
  // NEW: Overlays passed as parameters instead of imported from API
  overlayRegions: GridRegion[] = [],
  overlayRenderers: OverlayRegistration[] = [],
  // FIX: Sheet context for cross-sheet reference highlighting
  currentSheetName?: string,
): void {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const dims = dimensions || {
    columnWidths: new Map(),
    rowHeights: new Map(),
  };

  const styles = styleCache || new Map();

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
    selectionDragPreview: selectionDragPreview || null,
    clipboardSelection: clipboardSelection || null,
    clipboardMode: clipboardMode || "none",
    clipboardAnimationOffset: clipboardAnimationOffset || 0,
    insertionAnimation: insertionAnimation || undefined,
    freezeConfig: freezeConfig || { freezeRow: null, freezeCol: null },
    // FIX: Pass sheet context for cross-sheet reference highlighting
    currentSheetName,
    formulaSourceSheetName: editing?.sourceSheetName,
  };

  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(0, 0, width, height);

  const hasFreezeRows = freezeConfig && freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0;
  const hasFreezeCols = freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;
  
  if (hasFreezeRows || hasFreezeCols) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dims);
    
    const frozenColsX = rowHeaderWidth;
    const frozenRowsY = colHeaderHeight;
    const scrollableX = rowHeaderWidth + layout.frozenColsWidth;
    const scrollableY = colHeaderHeight + layout.frozenRowsHeight;
    const scrollableWidth = width - scrollableX;
    const scrollableHeight = height - scrollableY;
    
    const scrollableRange = calculateScrollableRange(viewport, freezeConfig!, config, width, height, dims);
    if (scrollableWidth > 0 && scrollableHeight > 0) {
      renderZone(state, scrollableRange, scrollableX, scrollableY, scrollableWidth, scrollableHeight);
    }
    
    if (hasFreezeCols) {
      const leftRange = calculateFrozenLeftRange(viewport, freezeConfig!, config, width, height, dims);
      if (leftRange && scrollableHeight > 0) {
        renderZone(state, leftRange, frozenColsX, scrollableY, layout.frozenColsWidth, scrollableHeight);
      }
    }
    
    if (hasFreezeRows) {
      const topRange = calculateFrozenTopRange(viewport, freezeConfig!, config, width, height, dims);
      if (topRange && scrollableWidth > 0) {
        renderZone(state, topRange, scrollableX, frozenRowsY, scrollableWidth, layout.frozenRowsHeight);
      }
    }
    
    if (hasFreezeRows && hasFreezeCols) {
      const topLeftRange = calculateFrozenTopLeftRange(freezeConfig!, config, width, height, dims);
      if (topLeftRange) {
        renderZone(state, topLeftRange, frozenColsX, frozenRowsY, layout.frozenColsWidth, layout.frozenRowsHeight);
      }
    }
    
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
    drawGridLines(state);
    drawCellText(state);
  }

  // Render overlays using INJECTED data (not imported from API)
  const sortedRenderers = [...overlayRenderers].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );
  for (const renderer of sortedRenderers) {
    const matchingRegions = overlayRegions.filter(r => r.type === renderer.type);
    for (const region of matchingRegions) {
      renderer.render({ ctx, region, config, viewport, dimensions: dims, canvasWidth: width, canvasHeight: height });
    }
  }

  if (formulaReferences.length > 0) {
    drawFormulaReferences(state);
  }

  if (fillPreviewRange) {
    drawFillPreview(state);
  }

  // Draw selection drag preview (shows where cells will move to)
  drawSelectionDragPreview(state);

  if (selection) {
    drawSelection(state);
  }

  if (clipboardSelection && clipboardMode && clipboardMode !== "none") {
    drawClipboardSelection(state);
  }

  drawColumnHeaders(state);
  drawRowHeaders(state);
  drawCorner(state);
}