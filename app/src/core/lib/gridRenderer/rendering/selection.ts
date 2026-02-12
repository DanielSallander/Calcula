//! FILENAME: app/src/core/lib/gridRenderer/rendering/selection.ts
// PURPOSE: Selection and active cell rendering
// CONTEXT: Draws selection highlights, active cell borders, fill handles, fill preview,
//          and clipboard marching ants animation
// UPDATED: Added freeze pane support for proper selection positioning

import type { RenderState } from "../types";
import type { FreezeConfig, DimensionOverrides, GridConfig, Viewport } from "../../../types";
import { calculateFreezePaneLayout } from "../layout/viewport";
import { getColumnWidth, getRowHeight } from "../layout/dimensions";

/**
 * Calculate the X position of a column accounting for freeze panes.
 * Frozen columns are at fixed positions, scrollable columns account for scroll offset.
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
    // Frozen column: fixed position
    let x = rowHeaderWidth;
    for (let c = 0; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    return x;
  } else if (freezeCol > 0) {
    // Scrollable column: account for frozen width and scroll offset
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollX = viewport.scrollX || 0;
    
    // Start after frozen columns
    let x = rowHeaderWidth + layout.frozenColsWidth;
    
    // Add width of scrollable columns before this one, minus scroll offset
    for (let c = freezeCol; c < col; c++) {
      x += getColumnWidth(c, config, dimensions);
    }
    x -= scrollX;
    
    return x;
  } else {
    // No freeze panes: standard calculation
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
 * Frozen rows are at fixed positions, scrollable rows account for scroll offset.
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
    // Frozen row: fixed position
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y;
  } else if (freezeRow > 0) {
    // Scrollable row: account for frozen height and scroll offset
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const scrollY = viewport.scrollY || 0;
    
    // Start after frozen rows
    let y = colHeaderHeight + layout.frozenRowsHeight;
    
    // Add height of scrollable rows before this one, minus scroll offset
    for (let r = freezeRow; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    y -= scrollY;
    
    return y;
  } else {
    // No freeze panes: standard calculation
    const scrollY = viewport.scrollY || 0;
    let y = colHeaderHeight;
    for (let r = 0; r < row; r++) {
      y += getRowHeight(r, config, dimensions);
    }
    return y - scrollY;
  }
}

/**
 * Draw the selection highlight.
 * Supports freeze panes with proper positioning across zones.
 * FIX: Skips drawing when viewing a different sheet during formula editing.
 */
export function drawSelection(state: RenderState): void {
  const {
    ctx, width, height, config, viewport, selection, theme, dimensions, freezeConfig,
    editing, currentSheetName, formulaSourceSheetName
  } = state;

  if (!selection) {
    return;
  }

  // FIX: When editing a formula and viewing a different sheet, don't draw the source sheet's selection
  // This prevents showing the wrong selection (e.g., B3 on Sheet1 appearing on Sheet2)
  if (editing && formulaSourceSheetName && currentSheetName) {
    const isOnDifferentSheet = currentSheetName.toLowerCase() !== formulaSourceSheetName.toLowerCase();
    if (isOnDifferentSheet) {
      return;
    }
  }
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);
  
  // Calculate positions using freeze-aware functions
  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig);
  
  // Calculate x2 by getting position of maxCol and adding its width
  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig) + 
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig) + 
             getRowHeight(maxRow, config, dimensions);
  
  // Clip to visible area (accounting for headers)
  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);
  
  // Additional clipping for freeze panes - prevent selection from overlapping frozen areas incorrectly
  const hasFrozenCols = freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0;
  const hasFrozenRows = freezeConfig && freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0;
  
  let clipX1 = visX1;
  let clipY1 = visY1;
  let clipX2 = visX2;
  let clipY2 = visY2;
  
  if (hasFrozenCols || hasFrozenRows) {
    const layout = calculateFreezePaneLayout(freezeConfig!, config, dimensions);
    const frozenColBoundary = rowHeaderWidth + layout.frozenColsWidth;
    const frozenRowBoundary = colHeaderHeight + layout.frozenRowsHeight;
    const freezeCol = freezeConfig!.freezeCol ?? 0;
    const freezeRow = freezeConfig!.freezeRow ?? 0;
    
    // If selection starts in scrollable area, don't let it extend into frozen area
    if (hasFrozenCols && minCol >= freezeCol) {
      clipX1 = Math.max(clipX1, frozenColBoundary);
    }
    if (hasFrozenRows && minRow >= freezeRow) {
      clipY1 = Math.max(clipY1, frozenRowBoundary);
    }
    
    // If selection ends in frozen area, don't let it extend into scrollable area
    if (hasFrozenCols && maxCol < freezeCol) {
      clipX2 = Math.min(clipX2, frozenColBoundary);
    }
    if (hasFrozenRows && maxRow < freezeRow) {
      clipY2 = Math.min(clipY2, frozenRowBoundary);
    }
  }
  
  if (clipX1 >= clipX2 || clipY1 >= clipY2) {
    return;
  }
  
  // Draw selection fill
  ctx.fillStyle = theme.selectionBackground;
  ctx.fillRect(clipX1, clipY1, clipX2 - clipX1, clipY2 - clipY1);

  // Draw selection border
  ctx.strokeStyle = theme.selectionBorder;
  ctx.lineWidth = 2;

  const borderX1 = clipX1 + 1;
  const borderY1 = clipY1 + 1;
  const borderX2 = clipX2 - 1;
  const borderY2 = clipY2 - 1;

  if (borderX2 > borderX1 && borderY2 > borderY1) {
    ctx.strokeRect(borderX1, borderY1, borderX2 - borderX1, borderY2 - borderY1);
  }

  // Draw fill handle (small square in bottom-right corner of selection)
  // Only draw if the bottom-right corner is in the visible/clipped area
  const handleSize = 8;
  const handleX = borderX2 - handleSize / 2;
  const handleY = borderY2 - handleSize / 2;
  
  if (handleX > rowHeaderWidth && handleY > colHeaderHeight &&
      handleX < width && handleY < height) {
    // White background for fill handle
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
    // Green border for fill handle
    ctx.strokeStyle = "#16a34a";
    ctx.lineWidth = 2;
    ctx.strokeRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
  }
}

/**
 * Draw clipboard selection with marching ants animation.
 * The dotted border animates to show cells are on the clipboard.
 * Supports freeze panes with proper positioning.
 */
export function drawClipboardSelection(state: RenderState): void {
  const { 
    ctx, width, height, config, viewport, dimensions, freezeConfig,
    clipboardSelection, clipboardMode, clipboardAnimationOffset = 0 
  } = state;

  if (!clipboardSelection || clipboardMode === "none") {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const minRow = Math.min(clipboardSelection.startRow, clipboardSelection.endRow);
  const maxRow = Math.max(clipboardSelection.startRow, clipboardSelection.endRow);
  const minCol = Math.min(clipboardSelection.startCol, clipboardSelection.endCol);
  const maxCol = Math.max(clipboardSelection.startCol, clipboardSelection.endCol);

  // Calculate positions using freeze-aware functions
  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig);
  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig) + 
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig) + 
             getRowHeight(maxRow, config, dimensions);

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  // Draw marching ants border
  const borderX = visX1 + 1;
  const borderY = visY1 + 1;
  const borderW = visX2 - visX1 - 2;
  const borderH = visY2 - visY1 - 2;

  // First pass: solid white background to make dashes visible on any cell color
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(borderX, borderY, borderW, borderH);

  // Second pass: colored dashed line with animation offset
  ctx.strokeStyle = clipboardMode === "cut" ? "#16a34a" : "#2563eb";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -clipboardAnimationOffset;
  ctx.strokeRect(borderX, borderY, borderW, borderH);
  
  // Reset line dash
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

/**
 * Draw the active cell indicator.
 * Supports freeze panes with proper positioning.
 */
export function drawActiveCell(state: RenderState): void {
  const { ctx, width, height, config, viewport, selection, editing, theme, dimensions, freezeConfig } = state;

  if (!selection) {
    return;
  }
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  
  const activeRow = selection.endRow;
  const activeCol = selection.endCol;
  const cellWidth = getColumnWidth(activeCol, config, dimensions);
  const cellHeight = getRowHeight(activeRow, config, dimensions);
  
  // Calculate position using freeze-aware functions
  const x = getColumnXWithFreeze(activeCol, config, dimensions, viewport, freezeConfig);
  const y = getRowYWithFreeze(activeRow, config, dimensions, viewport, freezeConfig);
  
  if (
    x + cellWidth < rowHeaderWidth ||
    x > width ||
    y + cellHeight < colHeaderHeight ||
    y > height
  ) {
    return;
  }
  
  const visX = Math.max(x, rowHeaderWidth);
  const visY = Math.max(y, colHeaderHeight);
  const visWidth = Math.min(x + cellWidth, width) - visX;
  const visHeight = Math.min(y + cellHeight, height) - visY;

  const isEditingThisCell = editing && editing.row === activeRow && editing.col === activeCol;

  if (!isEditingThisCell) {
    ctx.strokeStyle = theme.activeCellBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      Math.max(x, rowHeaderWidth) + 1,
      Math.max(y, colHeaderHeight) + 1,
      Math.min(cellWidth - 2, visWidth - 2),
      Math.min(cellHeight - 2, visHeight - 2)
    );
  }
}

/**
 * Draw the active cell background (white).
 * Supports freeze panes with proper positioning.
 */
export function drawActiveCellBackground(state: RenderState): void {
  const { ctx, width, height, config, viewport, selection, editing, theme, dimensions, freezeConfig } = state;

  if (!selection) {
    return;
  }
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  
  const activeRow = selection.endRow;
  const activeCol = selection.endCol;
  
  if (editing && editing.row === activeRow && editing.col === activeCol) {
    return;
  }
  const cellWidth = getColumnWidth(activeCol, config, dimensions);
  const cellHeight = getRowHeight(activeRow, config, dimensions);
  
  // Calculate position using freeze-aware functions
  const x = getColumnXWithFreeze(activeCol, config, dimensions, viewport, freezeConfig);
  const y = getRowYWithFreeze(activeRow, config, dimensions, viewport, freezeConfig);
  
  if (
    x + cellWidth < rowHeaderWidth ||
    x > width ||
    y + cellHeight < colHeaderHeight ||
    y > height
  ) {
    return;
  }
  
  const visX = Math.max(x, rowHeaderWidth);
  const visY = Math.max(y, colHeaderHeight);
  const visWidth = Math.min(x + cellWidth, width) - visX;
  const visHeight = Math.min(y + cellHeight, height) - visY;
  
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(visX, visY, visWidth, visHeight);
}

/**
 * Draw fill preview range (dashed border during fill drag).
 * Supports freeze panes with proper positioning.
 */
export function drawFillPreview(state: RenderState): void {
  const { ctx, width, height, config, viewport, dimensions, freezeConfig, fillPreviewRange } = state;

  if (!fillPreviewRange) {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const minRow = Math.min(fillPreviewRange.startRow, fillPreviewRange.endRow);
  const maxRow = Math.max(fillPreviewRange.startRow, fillPreviewRange.endRow);
  const minCol = Math.min(fillPreviewRange.startCol, fillPreviewRange.endCol);
  const maxCol = Math.max(fillPreviewRange.startCol, fillPreviewRange.endCol);

  // Calculate positions using freeze-aware functions
  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig);
  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig) + 
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig) + 
             getRowHeight(maxRow, config, dimensions);

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  // Draw semi-transparent fill
  ctx.fillStyle = "rgba(22, 163, 74, 0.1)";
  ctx.fillRect(visX1, visY1, visX2 - visX1, visY2 - visY1);

  // Draw dashed border
  ctx.strokeStyle = "#16a34a";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(visX1 + 1, visY1 + 1, visX2 - visX1 - 2, visY2 - visY1 - 2);
  ctx.setLineDash([]);
}

/**
 * Draw selection drag preview (dashed border showing where cells will be moved).
 * Supports freeze panes with proper positioning.
 */
export function drawSelectionDragPreview(state: RenderState): void {
  const { ctx, width, height, config, viewport, dimensions, freezeConfig, selectionDragPreview } = state;

  if (!selectionDragPreview) {
    return;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  const minRow = Math.min(selectionDragPreview.startRow, selectionDragPreview.endRow);
  const maxRow = Math.max(selectionDragPreview.startRow, selectionDragPreview.endRow);
  const minCol = Math.min(selectionDragPreview.startCol, selectionDragPreview.endCol);
  const maxCol = Math.max(selectionDragPreview.startCol, selectionDragPreview.endCol);

  // Calculate positions using freeze-aware functions
  const x1 = getColumnXWithFreeze(minCol, config, dimensions, viewport, freezeConfig);
  const y1 = getRowYWithFreeze(minRow, config, dimensions, viewport, freezeConfig);
  const x2 = getColumnXWithFreeze(maxCol, config, dimensions, viewport, freezeConfig) +
             getColumnWidth(maxCol, config, dimensions);
  const y2 = getRowYWithFreeze(maxRow, config, dimensions, viewport, freezeConfig) +
             getRowHeight(maxRow, config, dimensions);

  const visX1 = Math.max(x1, rowHeaderWidth);
  const visY1 = Math.max(y1, colHeaderHeight);
  const visX2 = Math.min(x2, width);
  const visY2 = Math.min(y2, height);

  if (visX1 >= visX2 || visY1 >= visY2) {
    return;
  }

  // Draw semi-transparent blue fill
  ctx.fillStyle = "rgba(33, 115, 215, 0.15)";
  ctx.fillRect(visX1, visY1, visX2 - visX1, visY2 - visY1);

  // Draw dashed blue border
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(visX1 + 1, visY1 + 1, visX2 - visX1 - 2, visY2 - visY1 - 2);
  ctx.setLineDash([]);
}