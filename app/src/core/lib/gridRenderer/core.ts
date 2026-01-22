// FILENAME: app/src/core/lib/gridRenderer/core.ts
// PURPOSE: Main rendering orchestration function
// CONTEXT: Coordinates all rendering phases for the grid
// UPDATED: Added freeze pane support with 4-zone rendering

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

/**
 * Render a single zone of the grid with clipping.
 */
function renderZone(
  state: RenderState,
  range: VisibleRange,
  clipX: number,
  clipY: number,
  clipWidth: number,
  clipHeight: number,
  zoneOffsetX: number,
  zoneOffsetY: number
): void {
  const { ctx, theme } = state;
  
  // Save context state
  ctx.save();
  
  // Set clipping region for this zone
  ctx.beginPath();
  ctx.rect(clipX, clipY, clipWidth, clipHeight);
  ctx.clip();
  
  // Create zone-specific render state
  const zoneState: RenderState = {
    ...state,
    // Override the visible range for this zone
    zoneRange: range,
    zoneOffsetX,
    zoneOffsetY,
  };
  
  // Clear zone background
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(clipX, clipY, clipWidth, clipHeight);
  
  // Draw grid lines for this zone
  drawGridLinesZone(zoneState, range, clipX, clipY, clipWidth, clipHeight);
  
  // Draw cell text for this zone
  drawCellTextZone(zoneState, range, clipX, clipY);
  
  // Restore context state
  ctx.restore();
}

/**
 * Draw grid lines for a specific zone.
 */
function drawGridLinesZone(
  state: RenderState,
  range: VisibleRange,
  clipX: number,
  clipY: number,
  clipWidth: number,
  clipHeight: number
): void {
  const { ctx, config, theme, dimensions } = state;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;
  
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  
  // Draw vertical lines
  let x = clipX + range.offsetX;
  for (let col = range.startCol; col <= range.endCol + 1 && col <= totalCols; col++) {
    if (x >= clipX && x <= clipX + clipWidth) {
      ctx.beginPath();
      ctx.moveTo(Math.floor(x) + 0.5, clipY);
      ctx.lineTo(Math.floor(x) + 0.5, clipY + clipHeight);
      ctx.stroke();
    }
    if (col <= range.endCol) {
      const colWidth = dimensions.columnWidths.get(col) ?? config.defaultCellWidth;
      x += colWidth;
    }
  }
  
  // Draw horizontal lines
  let y = clipY + range.offsetY;
  for (let row = range.startRow; row <= range.endRow + 1 && row <= totalRows; row++) {
    if (y >= clipY && y <= clipY + clipHeight) {
      ctx.beginPath();
      ctx.moveTo(clipX, Math.floor(y) + 0.5);
      ctx.lineTo(clipX + clipWidth, Math.floor(y) + 0.5);
      ctx.stroke();
    }
    if (row <= range.endRow) {
      const rowHeight = dimensions.rowHeights.get(row) ?? config.defaultCellHeight;
      y += rowHeight;
    }
  }
}

/**
 * Draw cell text for a specific zone.
 */
function drawCellTextZone(
  state: RenderState,
  range: VisibleRange,
  clipX: number,
  clipY: number
): void {
  const { ctx, config, theme, cells, editing, dimensions, styleCache } = state;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;
  const paddingX = 4;
  
  let baseY = clipY + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = dimensions.rowHeights.get(row) ?? config.defaultCellHeight;
    
    let baseX = clipX + range.offsetX;
    for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
      const colWidth = dimensions.columnWidths.get(col) ?? config.defaultCellWidth;
      
      // Skip if this cell is being edited
      if (editing && editing.row === row && editing.col === col) {
        baseX += colWidth;
        continue;
      }
      
      // Look up cell data
      const key = `${row},${col}`;
      const cell = cells.get(key);
      
      if (!cell || cell.display === "") {
        baseX += colWidth;
        continue;
      }
      
      // Get style
      const styleIndex = cell.styleIndex ?? 0;
      const cellStyle = styleCache.get(styleIndex) ?? styleCache.get(0);
      
      // Draw text
      ctx.save();
      ctx.beginPath();
      ctx.rect(baseX, baseY, colWidth, rowHeight);
      ctx.clip();
      
      ctx.font = `${cellStyle?.fontSize ?? 13}px ${cellStyle?.fontFamily ?? theme.cellFontFamily}`;
      ctx.fillStyle = cellStyle?.textColor ?? theme.cellText;
      ctx.textBaseline = "middle";
      
      const textX = baseX + paddingX;
      const textY = baseY + rowHeight / 2;
      ctx.fillText(cell.display, textX, textY, colWidth - paddingX * 2);
      
      ctx.restore();
      
      baseX += colWidth;
    }
    baseY += rowHeight;
  }
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
  freezeConfig?: FreezeConfig
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
      renderZone(state, scrollableRange, scrollableX, scrollableY, scrollableWidth, scrollableHeight, scrollableX, scrollableY);
    }
    
    // 2. Render bottom-left (frozen columns) zone
    if (hasFreezeCols) {
      const leftRange = calculateFrozenLeftRange(viewport, freezeConfig!, config, width, height, dims);
      if (leftRange && scrollableHeight > 0) {
        renderZone(state, leftRange, frozenColsX, scrollableY, layout.frozenColsWidth, scrollableHeight, frozenColsX, scrollableY);
      }
    }
    
    // 3. Render top-right (frozen rows) zone
    if (hasFreezeRows) {
      const topRange = calculateFrozenTopRange(viewport, freezeConfig!, config, width, height, dims);
      if (topRange && scrollableWidth > 0) {
        renderZone(state, topRange, scrollableX, frozenRowsY, scrollableWidth, layout.frozenRowsHeight, scrollableX, frozenRowsY);
      }
    }
    
    // 4. Render top-left (frozen corner) zone
    if (hasFreezeRows && hasFreezeCols) {
      const topLeftRange = calculateFrozenTopLeftRange(freezeConfig!, config, width, height, dims);
      if (topLeftRange) {
        renderZone(state, topLeftRange, frozenColsX, frozenRowsY, layout.frozenColsWidth, layout.frozenRowsHeight, frozenColsX, frozenRowsY);
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