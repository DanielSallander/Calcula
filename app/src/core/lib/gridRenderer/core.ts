//! FILENAME: app/src/core/lib/gridRenderer/core.ts
// PURPOSE: Main rendering orchestration function
// CONTEXT: Coordinates all rendering phases for the grid

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
  SplitConfig,
  VisibleRange,
  SpillRangeInfo,
  ViewMode,
} from "../../../core/types";
import type { GridTheme, RenderState } from "./types";
import { DEFAULT_THEME } from "./types";
import { drawCorner, drawColumnHeaders, drawRowHeaders } from "./rendering/headers";
import { drawGridLines } from "./rendering/grid";
import { drawCellText } from "./rendering/cells";
import { drawSelection, drawFillPreview, drawClipboardSelection, drawSelectionDragPreview } from "./rendering/selection";
import { drawSpillBorders } from "./rendering/spillBorder";
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
import { hasCellDecorations, applyCellDecorations } from "../../../api/cellDecorations";

// ============================================================================
// Post-Header Overlay Types
// ============================================================================

/**
 * A renderer that paints on top of all headers (row, column, and corner).
 * Called AFTER drawCorner() so it can overlay the header margin area.
 * Used by the Grouping extension to render the outline bar.
 */
export type GlobalOverlayRendererFn = (
  ctx: CanvasRenderingContext2D,
  config: GridConfig,
  viewport: Viewport,
  dimensions: DimensionOverrides,
  canvasWidth: number,
  canvasHeight: number,
) => void;

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
  /** When true, renders BEFORE the selection layer so selection draws on top. */
  renderBelowSelection?: boolean;
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

function getOverlayGapsForZone(
  overlayRegionBounds: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
  lineType: "vertical" | "horizontal",
  lineIndex: number,
): Array<{ start: number; end: number }> {
  const gaps: Array<{ start: number; end: number }> = [];
  for (const region of overlayRegionBounds) {
    if (lineType === "vertical") {
      if (lineIndex > region.startCol && lineIndex <= region.endCol) {
        gaps.push({ start: region.startRow, end: region.endRow + 1 });
      }
    } else {
      if (lineIndex > region.startRow && lineIndex <= region.endRow) {
        gaps.push({ start: region.startCol, end: region.endCol + 1 });
      }
    }
  }
  return gaps;
}

function getLineSegments(
  cells: Map<string, { rowSpan?: number; colSpan?: number }>,
  lineType: "vertical" | "horizontal",
  lineIndex: number,
  perpStart: number,
  perpEnd: number,
  overlayRegionBounds?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
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

  // Also add gaps from overlay regions
  if (overlayRegionBounds && overlayRegionBounds.length > 0) {
    gaps.push(...getOverlayGapsForZone(overlayRegionBounds, lineType, lineIndex));
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
  const { ctx, config, theme, dimensions, cells, overlayRegionBounds } = state;
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
        range.endRow,
        overlayRegionBounds,
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
        range.endCol,
        overlayRegionBounds,
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
  const { ctx, config, viewport, theme, cells, editing, dimensions, styleCache } = state;
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
      
      // In Show Formulas mode, use "=formula" for formula cells
      let cellDisplayText = (state.showFormulas && cell?.formula)
        ? cell.formula
        : cell?.display ?? "";

      // In Display Zeros = false mode, hide zero values for non-formula cells
      if (state.displayZeros === false && cell && !cell.formula && cellDisplayText !== "") {
        const num = Number(cellDisplayText);
        if (num === 0 && !isNaN(num)) {
          cellDisplayText = "";
        }
      }

      if (!cell || cellDisplayText === "") {
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

      // Draw cell decorations (e.g., sparklines) between background and text
      if (hasCellDecorations()) {
        applyCellDecorations({ ctx, row, col, cellLeft, cellTop, cellRight, cellBottom, config, viewport, dimensions, display: cellDisplayText, styleIndex, styleCache });
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
      if (state.showFormulas && cell.formula) {
        textAlign = "left";
      } else if (cellStyle?.textAlign === "right") {
        textAlign = "right";
      } else if (cellStyle?.textAlign === "center") {
        textAlign = "center";
      } else if (cellStyle?.textAlign === "general" || !cellStyle?.textAlign) {
        const numericPattern = /^-?[\d,]+\.?\d*%?$|^-?\.\d+%?$/;
        if (numericPattern.test(cellDisplayText.trim())) {
          textAlign = "right";
        }
      }

      ctx.textAlign = "left";
      let drawX = textX;
      const textMetrics = ctx.measureText(cellDisplayText);
      const textWidth = Math.min(textMetrics.width, availableWidth);

      if (textAlign === "right") {
        drawX = cellLeft + (cellRight - cellLeft) - paddingX - textWidth;
      } else if (textAlign === "center") {
        drawX = cellLeft + ((cellRight - cellLeft) - textWidth) / 2;
      }

      ctx.fillText(cellDisplayText, drawX, textY, availableWidth);
      
      if (cellStyle?.underline && cellStyle.underline !== "none") {
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
  selectionDragMode?: "move" | "copy",
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
  // Post-header renderers run AFTER all headers are drawn (e.g. outline bar)
  postHeaderRenderers: GlobalOverlayRendererFn[] = [],
  // Spill range borders for dynamic array formulas
  spillRanges: SpillRangeInfo[] = [],
  // Split window configuration
  splitConfig?: SplitConfig,
  // Secondary viewport for split window (top-left pane's independent scroll)
  splitViewport?: Viewport,
  // View mode for page layout rendering
  viewMode?: ViewMode,
  // Page setup for page layout view
  pageSetup?: { marginTop: number; marginBottom: number; marginLeft: number; marginRight: number; paperWidth: number; paperHeight: number; header: string; footer: string },
  // Show Formulas mode - display raw formulas instead of calculated values
  showFormulas?: boolean,
  // Display Zeros mode - when false, zero values display as blank
  displayZeros?: boolean,
): void {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const dims = dimensions || {
    columnWidths: new Map(),
    rowHeights: new Map(),
  };

  const styles = styleCache || new Map();

  // When split is active, use the split config as freeze config so that
  // headers and selection rendering use the freeze-aware code path.
  const hasSplit = splitConfig &&
    ((splitConfig.splitRow !== null && splitConfig.splitRow > 0) ||
     (splitConfig.splitCol !== null && splitConfig.splitCol > 0));
  const effectiveFreezeConfig = hasSplit
    ? { freezeRow: splitConfig!.splitRow ?? null, freezeCol: splitConfig!.splitCol ?? null }
    : (freezeConfig || { freezeRow: null, freezeCol: null });
  const splitBarThickness = hasSplit ? 4 : 0;

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
    selectionDragMode: selectionDragMode || "move",
    clipboardSelection: clipboardSelection || null,
    clipboardMode: clipboardMode || "none",
    clipboardAnimationOffset: clipboardAnimationOffset || 0,
    insertionAnimation: insertionAnimation || undefined,
    freezeConfig: effectiveFreezeConfig,
    // FIX: Pass sheet context for cross-sheet reference highlighting
    currentSheetName,
    formulaSourceSheetName: editing?.sourceSheetName,
    // Pass overlay region bounds for grid line suppression
    overlayRegionBounds: overlayRegions
      .filter(r => !r.floating)
      .map(r => ({ startRow: r.startRow, startCol: r.startCol, endRow: r.endRow, endCol: r.endCol })),
    // Spill ranges for blue dashed borders
    spillRanges,
    // Split bar size for offset calculations in headers and selection
    splitBarSize: splitBarThickness,
    // Independent split viewport for headers
    splitViewport: hasSplit ? splitViewport : undefined,
    // Show Formulas mode
    showFormulas: showFormulas || false,
    // Display Zeros mode
    displayZeros: displayZeros !== undefined ? displayZeros : true,
  };

  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(0, 0, width, height);

  // Split window rendering
  const hasSplitRows = splitConfig && splitConfig.splitRow !== null && splitConfig.splitRow > 0;
  const hasSplitCols = splitConfig && splitConfig.splitCol !== null && splitConfig.splitCol > 0;

  if (hasSplitRows || hasSplitCols) {
    // Split windows create independent scrollable panes.
    // We use calculateFreezePaneLayout only to get the pixel position of the split bar.
    // Each pane uses calculateVisibleRange with its own viewport for fully independent scrolling.
    const splitFreezeConfig: FreezeConfig = {
      freezeRow: splitConfig!.splitRow ?? null,
      freezeCol: splitConfig!.splitCol ?? null,
    };
    const layout = calculateFreezePaneLayout(splitFreezeConfig, config, dims);

    const splitBarSize = 4;
    const topPaneHeight = layout.frozenRowsHeight;
    const leftPaneWidth = layout.frozenColsWidth;
    const splitXPixel = rowHeaderWidth + leftPaneWidth;
    const splitYPixel = colHeaderHeight + topPaneHeight;
    const bottomPaneTop = splitYPixel + (hasSplitRows ? splitBarSize : 0);
    const rightPaneLeft = splitXPixel + (hasSplitCols ? splitBarSize : 0);
    const bottomPaneHeight = height - bottomPaneTop;
    const rightPaneWidth = width - rightPaneLeft;

    // Split viewport for top/left panes; falls back to scrollY=0,scrollX=0 if not provided
    const svp = splitViewport || { ...viewport, scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 50, colCount: 20 };

    // Bottom-right pane: uses main viewport for both axes
    if (rightPaneWidth > 0 && bottomPaneHeight > 0) {
      // Trick: add header sizes so calculateVisibleRange subtracts them to get correct pane size
      const brRange = calculateVisibleRange(viewport, config, rightPaneWidth + rowHeaderWidth, bottomPaneHeight + colHeaderHeight, dims);
      renderZone(state, brRange, rightPaneLeft, bottomPaneTop, rightPaneWidth, bottomPaneHeight);
    }

    // Bottom-left pane: scrolls vertically with main viewport, horizontally with split viewport
    if (hasSplitCols && leftPaneWidth > 0 && bottomPaneHeight > 0) {
      const blViewport: Viewport = { ...viewport, scrollX: svp.scrollX };
      const blRange = calculateVisibleRange(blViewport, config, leftPaneWidth + rowHeaderWidth, bottomPaneHeight + colHeaderHeight, dims);
      renderZone(state, blRange, rowHeaderWidth, bottomPaneTop, leftPaneWidth, bottomPaneHeight);
    }

    // Top-right pane: scrolls horizontally with main viewport, vertically with split viewport
    if (hasSplitRows && topPaneHeight > 0 && rightPaneWidth > 0) {
      const trViewport: Viewport = { ...viewport, scrollY: svp.scrollY };
      const trRange = calculateVisibleRange(trViewport, config, rightPaneWidth + rowHeaderWidth, topPaneHeight + colHeaderHeight, dims);
      renderZone(state, trRange, rightPaneLeft, colHeaderHeight, rightPaneWidth, topPaneHeight);
    }

    // Top-left pane: independent scroll from split viewport (both axes)
    if (hasSplitRows && hasSplitCols && topPaneHeight > 0 && leftPaneWidth > 0) {
      const tlRange = calculateVisibleRange(svp, config, leftPaneWidth + rowHeaderWidth, topPaneHeight + colHeaderHeight, dims);
      renderZone(state, tlRange, rowHeaderWidth, colHeaderHeight, leftPaneWidth, topPaneHeight);
    }

    // Draw split bars
    ctx.fillStyle = "#c0c0c0";
    if (hasSplitCols && leftPaneWidth > 0) {
      ctx.fillRect(splitXPixel, colHeaderHeight, splitBarSize, height - colHeaderHeight);
    }
    if (hasSplitRows && topPaneHeight > 0) {
      ctx.fillRect(rowHeaderWidth, splitYPixel, width - rowHeaderWidth, splitBarSize);
    }
    // Draw 3D effect on split bars
    ctx.strokeStyle = "#999999";
    ctx.lineWidth = 1;
    if (hasSplitCols && leftPaneWidth > 0) {
      ctx.beginPath();
      ctx.moveTo(splitXPixel + 0.5, colHeaderHeight);
      ctx.lineTo(splitXPixel + 0.5, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(splitXPixel + splitBarSize - 0.5, colHeaderHeight);
      ctx.lineTo(splitXPixel + splitBarSize - 0.5, height);
      ctx.stroke();
    }
    if (hasSplitRows && topPaneHeight > 0) {
      ctx.beginPath();
      ctx.moveTo(rowHeaderWidth, splitYPixel + 0.5);
      ctx.lineTo(width, splitYPixel + 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(rowHeaderWidth, splitYPixel + splitBarSize - 0.5);
      ctx.lineTo(width, splitYPixel + splitBarSize - 0.5);
      ctx.stroke();
    }
  }

  const hasFreezeRows = !hasSplitRows && !hasSplitCols && freezeConfig && freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0;
  const hasFreezeCols = !hasSplitRows && !hasSplitCols && freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;

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
    
  } else if (!hasSplitRows && !hasSplitCols) {
    drawGridLines(state);
    drawCellText(state);
  }

  if (formulaReferences.length > 0) {
    drawFormulaReferences(state);
  }

  if (fillPreviewRange) {
    drawFillPreview(state);
  }

  // Draw selection drag preview (shows where cells will move to)
  drawSelectionDragPreview(state);

  // Split overlays into two groups:
  // - belowSelection: cell-based overlays (e.g., pivot) that render BEFORE selection
  //   so the standard selection highlight draws on top of them
  // - aboveSelection: floating overlays (e.g., charts) that render AFTER selection
  //   to prevent selection borders from bleeding through
  const sortedRenderers = [...overlayRenderers].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );
  const belowSelectionRenderers = sortedRenderers.filter(r => r.renderBelowSelection === true);
  const aboveSelectionRenderers = sortedRenderers.filter(r => r.renderBelowSelection !== true);

  // Compute insertion animation offset so overlays animate in sync with cells.
  // During an insertion animation, cells at/after the change point are rendered
  // with an offset that slides them from old to new position. Overlays (e.g.,
  // pivot tables) need the same offset to stay visually aligned with the cells
  // they cover.
  const anim = state.insertionAnimation;
  let animOverlayOffsetX = 0;
  let animOverlayOffsetY = 0;
  let animOverlayThreshold = -1;   // col or row index threshold
  let animOverlayAxis: "col" | "row" = "col";
  if (anim) {
    const totalOffset = anim.targetSize * anim.count;
    const remainingOffset = (1 - anim.progress) * totalOffset;
    const signedOffset = anim.direction === "insert" ? -remainingOffset : remainingOffset;
    animOverlayThreshold = anim.index;
    if (anim.type === "column") {
      animOverlayAxis = "col";
      animOverlayOffsetX = signedOffset;
    } else {
      animOverlayAxis = "row";
      animOverlayOffsetY = signedOffset;
    }
  }

  // Helper: render an overlay region, applying insertion animation offset if needed
  const renderOverlayRegion = (renderer: OverlayRegistration, region: GridRegion) => {
    const needsOffset = anim && !region.floating && (
      (animOverlayAxis === "col" && region.startCol >= animOverlayThreshold) ||
      (animOverlayAxis === "row" && region.startRow >= animOverlayThreshold)
    );
    if (needsOffset) {
      ctx.save();
      ctx.translate(animOverlayOffsetX, animOverlayOffsetY);
    }
    renderer.render({ ctx, region, config, viewport, dimensions: dims, canvasWidth: width, canvasHeight: height });
    if (needsOffset) {
      ctx.restore();
    }
  };

  // Render below-selection overlays (e.g., pivot tables)
  for (const renderer of belowSelectionRenderers) {
    const matchingRegions = overlayRegions.filter(r => r.type === renderer.type);
    for (const region of matchingRegions) {
      renderOverlayRegion(renderer, region);
    }
  }

  // Draw spill range borders (blue dashed) before selection so selection draws on top
  drawSpillBorders(state);

  if (selection) {
    drawSelection(state);
  }

  if (clipboardSelection && clipboardMode && clipboardMode !== "none") {
    drawClipboardSelection(state);
  }

  // Render above-selection overlays (e.g., charts)
  for (const renderer of aboveSelectionRenderers) {
    const matchingRegions = overlayRegions.filter(r => r.type === renderer.type);
    for (const region of matchingRegions) {
      renderOverlayRegion(renderer, region);
    }
  }

  drawColumnHeaders(state);
  drawRowHeaders(state);
  drawCorner(state);

  // Post-header renderers: draw on top of all headers (e.g. outline bar)
  for (const renderer of postHeaderRenderers) {
    renderer(ctx, config, viewport, dims, width, height);
  }

  // Page Layout View: draw page boundaries, margins, and header/footer areas
  if (viewMode === "pageLayout" && pageSetup) {
    drawPageLayoutOverlay(ctx, config, viewport, dims, width, height, pageSetup);
  }
}

// ============================================================================
// Page Layout View Rendering
// ============================================================================

function drawPageLayoutOverlay(
  ctx: CanvasRenderingContext2D,
  config: GridConfig,
  viewport: Viewport,
  dimensions: DimensionOverrides,
  canvasWidth: number,
  canvasHeight: number,
  pageSetup: { marginTop: number; marginBottom: number; marginLeft: number; marginRight: number; paperWidth: number; paperHeight: number; header: string; footer: string },
): void {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const scrollX = viewport.scrollX || 0;
  const scrollY = viewport.scrollY || 0;

  // Convert paper dimensions (inches at 96 DPI) to pixels
  const pageWidthPx = pageSetup.paperWidth * 96;
  const pageHeightPx = pageSetup.paperHeight * 96;
  const marginTopPx = pageSetup.marginTop * 96;
  const marginBottomPx = pageSetup.marginBottom * 96;
  const marginLeftPx = pageSetup.marginLeft * 96;
  const marginRightPx = pageSetup.marginRight * 96;

  // Draw page boundary lines (blue dashed)
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#4472c4";
  ctx.lineWidth = 1.5;

  // Calculate page breaks based on accumulated column widths and row heights
  // Vertical page breaks (between columns)
  let accWidth = 0;
  const printableWidth = pageWidthPx - marginLeftPx - marginRightPx;
  let pageStartCol = 0;
  for (let col = 0; col < (config.totalCols || 100); col++) {
    const colW = getColumnWidth(col, config, dimensions);
    accWidth += colW;
    if (accWidth > printableWidth && col > pageStartCol) {
      // Draw vertical page break
      const breakX = rowHeaderWidth + accWidth - colW - scrollX;
      if (breakX > rowHeaderWidth && breakX < canvasWidth) {
        ctx.beginPath();
        ctx.moveTo(Math.floor(breakX) + 0.5, colHeaderHeight);
        ctx.lineTo(Math.floor(breakX) + 0.5, canvasHeight);
        ctx.stroke();
      }
      accWidth = colW;
      pageStartCol = col;
    }
  }

  // Horizontal page breaks (between rows)
  let accHeight = 0;
  const printableHeight = pageHeightPx - marginTopPx - marginBottomPx;
  let pageStartRow = 0;
  for (let row = 0; row < (config.totalRows || 1000); row++) {
    const rowH = getRowHeight(row, config, dimensions);
    accHeight += rowH;
    if (accHeight > printableHeight && row > pageStartRow) {
      // Draw horizontal page break
      const breakY = colHeaderHeight + accHeight - rowH - scrollY;
      if (breakY > colHeaderHeight && breakY < canvasHeight) {
        ctx.beginPath();
        ctx.moveTo(rowHeaderWidth, Math.floor(breakY) + 0.5);
        ctx.lineTo(canvasWidth, Math.floor(breakY) + 0.5);
        ctx.stroke();
      }
      accHeight = rowH;
      pageStartRow = row;
    }
  }
  ctx.setLineDash([]);

  // Draw margin indicators (light gray shading)
  ctx.fillStyle = "rgba(200, 200, 200, 0.15)";
  // Top margin area
  if (marginTopPx > 0) {
    const marginTopHeight = Math.min(marginTopPx, canvasHeight - colHeaderHeight);
    const topMarginY = colHeaderHeight - scrollY;
    if (topMarginY + marginTopHeight > colHeaderHeight) {
      ctx.fillRect(rowHeaderWidth, Math.max(colHeaderHeight, topMarginY), canvasWidth - rowHeaderWidth, Math.min(marginTopHeight, canvasHeight - colHeaderHeight));
    }
  }

  // Draw header text in the top margin
  if (pageSetup.header) {
    ctx.fillStyle = "#666666";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const headerY = colHeaderHeight + Math.min(marginTopPx / 2, 15) - scrollY;
    if (headerY > colHeaderHeight && headerY < canvasHeight) {
      const parts = parseHeaderFooter(pageSetup.header);
      if (parts.left) {
        ctx.textAlign = "left";
        ctx.fillText(parts.left, rowHeaderWidth + marginLeftPx - scrollX + 4, headerY);
      }
      if (parts.center) {
        ctx.textAlign = "center";
        ctx.fillText(parts.center, rowHeaderWidth + (canvasWidth - rowHeaderWidth) / 2, headerY);
      }
      if (parts.right) {
        ctx.textAlign = "right";
        ctx.fillText(parts.right, canvasWidth - marginRightPx + scrollX - 4, headerY);
      }
    }
  }

  // Draw footer text at bottom of page
  if (pageSetup.footer) {
    ctx.fillStyle = "#666666";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    // Show footer at first page boundary
    const firstPageBottom = colHeaderHeight + printableHeight + marginTopPx - scrollY;
    const footerY = firstPageBottom + marginBottomPx / 2;
    if (footerY > colHeaderHeight && footerY < canvasHeight) {
      const parts = parseHeaderFooter(pageSetup.footer);
      if (parts.left) {
        ctx.textAlign = "left";
        ctx.fillText(parts.left, rowHeaderWidth + marginLeftPx - scrollX + 4, footerY);
      }
      if (parts.center) {
        ctx.textAlign = "center";
        ctx.fillText(parts.center, rowHeaderWidth + (canvasWidth - rowHeaderWidth) / 2, footerY);
      }
      if (parts.right) {
        ctx.textAlign = "right";
        ctx.fillText(parts.right, canvasWidth - marginRightPx + scrollX - 4, footerY);
      }
    }
  }

  ctx.restore();
}

/**
 * Parse Excel-style header/footer format codes: &L, &C, &R for left/center/right.
 * Also replaces &P (page number), &N (total pages), &D (date), &T (time), &F (filename).
 */
function parseHeaderFooter(format: string): { left: string; center: string; right: string } {
  const result = { left: "", center: "", right: "" };
  if (!format) return result;

  // Split by &L, &C, &R sections
  const sections = format.split(/&([LCR])/i);
  let currentSection: "left" | "center" | "right" = "center"; // default is center

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section.toUpperCase() === "L") { currentSection = "left"; continue; }
    if (section.toUpperCase() === "C") { currentSection = "center"; continue; }
    if (section.toUpperCase() === "R") { currentSection = "right"; continue; }

    // Replace format codes with display values
    let text = section
      .replace(/&P/gi, "1")
      .replace(/&N/gi, "1")
      .replace(/&D/gi, new Date().toLocaleDateString())
      .replace(/&T/gi, new Date().toLocaleTimeString())
      .replace(/&F/gi, "Workbook");

    result[currentSection] += text;
  }

  return result;
}