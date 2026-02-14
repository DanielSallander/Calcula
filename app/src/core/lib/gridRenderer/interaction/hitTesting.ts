//! FILENAME: app/src/core/lib/gridRenderer/interaction/hitTesting.ts
//PURPOSE: Pixel coordinate to cell coordinate conversion and resize handle detection
//CONTEXT: Handles mouse interaction with grid cells, headers, and resize handles
//UPDATED: Added freeze pane support for coordinate translation
//UPDATED: Added formula reference border detection for reference dragging

import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig, FreezeZone, FormulaReference, Selection } from "../../../types";
import { ensureDimensions } from "../styles/styleUtils";
import { getColumnWidth, getRowHeight, getColumnX, getRowY } from "../layout/dimensions";
import { calculateVisibleRange, calculateFreezePaneLayout } from "../layout/viewport";

// =============================================================================
// SELECTION THRESHOLDS
// =============================================================================
// X = 0.0: Instant selection (cell selects as soon as cursor touches it)
// Y = 1.2: Delayed selection (requires dragging significantly past the border)
const SELECTION_THRESHOLD_X = 0.0;
const SELECTION_THRESHOLD_Y = 0.0;

/**
 * Options for getCellFromPixel behavior.
 */
export interface GetCellOptions {
  /**
   * The starting row of the drag operation.
   * Required for relative threshold calculation.
   */
  dragStartRow?: number;
  
  /**
   * The starting column of the drag operation.
   * Required for relative threshold calculation.
   */
  dragStartCol?: number;
  
  /**
   * Freeze pane configuration for coordinate translation.
   */
  freezeConfig?: FreezeConfig;
}

/**
 * Result from getCellFromPixel including zone information.
 */
export interface CellFromPixelResult {
  row: number;
  col: number;
  zone: FreezeZone;
}

/**
 * Determine which freeze zone a pixel coordinate falls into.
 */
export function getZoneFromPixel(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  freezeConfig: FreezeConfig,
  dimensions?: DimensionOverrides
): FreezeZone {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  
  // If no freeze, everything is in bottomRight (main scrollable)
  if ((freezeConfig.freezeRow === null || freezeConfig.freezeRow <= 0) &&
      (freezeConfig.freezeCol === null || freezeConfig.freezeCol <= 0)) {
    return "bottomRight";
  }
  
  const layout = calculateFreezePaneLayout(freezeConfig, config, dimensions);
  
  const inFrozenCols = freezeConfig.freezeCol !== null && 
                       freezeConfig.freezeCol > 0 && 
                       pixelX < rowHeaderWidth + layout.frozenColsWidth;
  const inFrozenRows = freezeConfig.freezeRow !== null && 
                       freezeConfig.freezeRow > 0 && 
                       pixelY < colHeaderHeight + layout.frozenRowsHeight;
  
  if (inFrozenRows && inFrozenCols) {
    return "topLeft";
  } else if (inFrozenRows) {
    return "topRight";
  } else if (inFrozenCols) {
    return "bottomLeft";
  } else {
    return "bottomRight";
  }
}

/**
 * Get cell coordinates from pixel position.
 * Returns null if click is on headers.
 * Handles frozen pane coordinate translation.
 * 
 * @param pixelX - X coordinate in pixels relative to container
 * @param pixelY - Y coordinate in pixels relative to container
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param dimensions - Optional dimension overrides
 * @param options - Optional behavior options including freeze config
 */
export function getCellFromPixel(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides,
  options?: GetCellOptions
): { row: number; col: number } | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const totalCols = config.totalCols || 100;
  
  const dragStartRow = options?.dragStartRow;
  const dragStartCol = options?.dragStartCol;
  const freezeConfig = options?.freezeConfig;
  
  // Check if click is on headers
  if (pixelX < rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }
  
  const dims = ensureDimensions(dimensions);
  const scrollX = viewport.scrollX || 0;
  const scrollY = viewport.scrollY || 0;

  // Determine which zone we're in and calculate appropriate content position
  let contentX: number;
  let contentY: number;
  let startCol = 0;
  let startRow = 0;
  
  if (freezeConfig && (freezeConfig.freezeRow !== null || freezeConfig.freezeCol !== null)) {
    const layout = calculateFreezePaneLayout(freezeConfig, config, dims);
    const zone = getZoneFromPixel(pixelX, pixelY, config, freezeConfig, dims);
    
    switch (zone) {
      case "topLeft":
        // Frozen corner - no scroll offset
        contentX = pixelX - rowHeaderWidth;
        contentY = pixelY - colHeaderHeight;
        break;
        
      case "topRight":
        // Frozen rows - horizontal scroll only
        contentX = pixelX - rowHeaderWidth - layout.frozenColsWidth + scrollX;
        contentY = pixelY - colHeaderHeight;
        startCol = freezeConfig.freezeCol ?? 0;
        break;
        
      case "bottomLeft":
        // Frozen columns - vertical scroll only
        contentX = pixelX - rowHeaderWidth;
        contentY = pixelY - colHeaderHeight - layout.frozenRowsHeight + scrollY;
        startRow = freezeConfig.freezeRow ?? 0;
        break;
        
      case "bottomRight":
        // Main scrollable area - both scrolls
        contentX = pixelX - rowHeaderWidth - layout.frozenColsWidth + scrollX;
        contentY = pixelY - colHeaderHeight - layout.frozenRowsHeight + scrollY;
        startCol = freezeConfig.freezeCol ?? 0;
        startRow = freezeConfig.freezeRow ?? 0;
        break;
    }
  } else {
    // No freeze panes - standard calculation
    contentX = pixelX - rowHeaderWidth + scrollX;
    contentY = pixelY - colHeaderHeight + scrollY;
  }

  // =========================================================================
  // COLUMN CALCULATION
  // =========================================================================
  
  let col = startCol;
  let accumulatedWidth = 0;
  let currentColWidth = 0;
  
  // For frozen zones, we need to account for frozen columns' width offset
  if (freezeConfig && freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0 && startCol === 0) {
    // We're in a frozen column zone - start from column 0
  } else if (startCol > 0) {
    // We're past frozen columns - content already adjusted for scroll
  }
  
  // Find the physical column under the cursor
  while (col < totalCols) {
    currentColWidth = getColumnWidth(col, config, dims);
    if (currentColWidth <= 0) break; 
    
    if (accumulatedWidth + currentColWidth > contentX) {
      break;
    }
    
    accumulatedWidth += currentColWidth;
    col++;
  }

  // Apply Relative Threshold Logic
  if (dragStartCol !== undefined && col !== dragStartCol) {
    const relativePos = (contentX - accumulatedWidth) / currentColWidth;

    if (col > dragStartCol) {
      if (relativePos < SELECTION_THRESHOLD_X) {
        col--;
      }
    } else {
      if (relativePos > (1 - SELECTION_THRESHOLD_X)) {
        col++;
      }
    }
  }

  // Clamp Column
  if (col < 0) col = 0;
  if (col >= totalCols) col = totalCols - 1;
  
  // =========================================================================
  // ROW CALCULATION
  // =========================================================================
  
  let row = startRow;
  let accumulatedHeight = 0;
  let currentRowHeight = 0;
  
  // Find the physical row under the cursor
  while (row < totalRows) {
    currentRowHeight = getRowHeight(row, config, dims);
    if (currentRowHeight <= 0) break;

    if (accumulatedHeight + currentRowHeight > contentY) {
      break;
    }
    accumulatedHeight += currentRowHeight;
    row++;
  }
  
  // Apply Relative Threshold Logic
  if (dragStartRow !== undefined && row !== dragStartRow) {
    const relativePos = (contentY - accumulatedHeight) / currentRowHeight;

    if (row > dragStartRow) {
      if (relativePos < SELECTION_THRESHOLD_Y) {
        row--;
      }
    } else {
      if (relativePos > (1 - SELECTION_THRESHOLD_Y)) {
        row++;
      }
    }
  }

  // Clamp Row
  if (row < 0) row = 0;
  if (row >= totalRows) row = totalRows - 1;
  
  // Final bounds check
  if (row < 0 || row >= totalRows || col < 0 || col >= totalCols) {
    return null;
  }
  
  return { row, col };
}

/**
 * Check if a pixel position is on a column resize handle.
 * Returns the column index if on a resize handle, null otherwise.
 */
export function getColumnResizeHandle(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalCols = config.totalCols || 100;
  const handleWidth = 6; 

  if (pixelY >= colHeaderHeight) return null;
  if (pixelX < rowHeaderWidth) return null;

  const dims = ensureDimensions(dimensions);
  const range = calculateVisibleRange(viewport, config, pixelX + handleWidth, colHeaderHeight, dims);
  let x = rowHeaderWidth + range.offsetX;
  for (let col = range.startCol; col <= range.endCol && col < totalCols; col++) {
    const colWidth = getColumnWidth(col, config, dims);
    x += colWidth;
    if (Math.abs(pixelX - x) <= handleWidth / 2) {
      return col;
    }
  }
  return null;
}

/**
 * Check if a pixel position is on a row resize handle.
 * Returns the row index if on a resize handle, null otherwise.
 */
export function getRowResizeHandle(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;
  const handleHeight = 6; 

  if (pixelX >= rowHeaderWidth) return null;
  if (pixelY < colHeaderHeight) return null;

  const dims = ensureDimensions(dimensions);
  const range = calculateVisibleRange(viewport, config, rowHeaderWidth, pixelY + handleHeight, dims);
  let y = colHeaderHeight + range.offsetY;
  for (let row = range.startRow; row <= range.endRow && row < totalRows; row++) {
    const rowHeight = getRowHeight(row, config, dims);
    y += rowHeight;
    if (Math.abs(pixelY - y) <= handleHeight / 2) {
      return row;
    }
  }
  return null;
}

/**
 * Get the column index from a click in the column header area.
 * Returns null if not in the column header area.
 */
export function getColumnFromHeader(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalCols = config.totalCols || 100;

  if (pixelY >= colHeaderHeight || pixelX < rowHeaderWidth) return null;
  
  const dims = ensureDimensions(dimensions);
  const scrollX = viewport.scrollX || 0;

  const contentX = pixelX - rowHeaderWidth + scrollX;
  let col = 0;
  let accumulatedWidth = 0;
  while (col < totalCols) {
    const colWidth = getColumnWidth(col, config, dims);
    if (colWidth <= 0) break;
    if (accumulatedWidth + colWidth > contentX) {
      return col;
    }
    accumulatedWidth += colWidth;
    col++;
  }
  return null;
}

/**
 * Get the row index from a click in the row header area.
 * Returns null if not in the row header area.
 */
export function getRowFromHeader(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides
): number | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const totalRows = config.totalRows || 1000;

  if (pixelX >= rowHeaderWidth || pixelY < colHeaderHeight) return null;
  
  const dims = ensureDimensions(dimensions);
  const scrollY = viewport.scrollY || 0;

  const contentY = pixelY - colHeaderHeight + scrollY;
  let row = 0;
  let accumulatedHeight = 0;
  while (row < totalRows) {
    const rowHeight = getRowHeight(row, config, dims);
    if (rowHeight <= 0) break;
    if (accumulatedHeight + rowHeight > contentY) {
      return row;
    }
    accumulatedHeight += rowHeight;
    row++;
  }
  return null;
}

/**
 * Threshold in pixels for detecting mouse hover over reference border.
 */
const REFERENCE_BORDER_THRESHOLD = 5;

/**
 * Size of the corner resize handle hit area (pixels).
 * The visual handle is 7x7; the hit area is slightly larger for easier targeting.
 */
const REFERENCE_CORNER_HIT_SIZE = 9;

/**
 * Which corner of a reference was hit.
 */
export type ReferenceCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/**
 * Result from getFormulaReferenceBorderAtPixel.
 */
export interface ReferenceBorderHit {
  /** Index of the reference in the array */
  refIndex: number;
  /** The reference that was hit */
  reference: FormulaReference;
}

/**
 * Check if a pixel position is on the border of a formula reference.
 * Returns the reference info if on a border, null otherwise.
 * This is used for the reference dragging feature - users can only
 * drag a reference by clicking on its border (like in Excel).
 *
 * @param pixelX - X coordinate in pixels relative to container
 * @param pixelY - Y coordinate in pixels relative to container
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param formulaReferences - Array of formula references to check
 * @param dimensions - Optional dimension overrides
 * @param currentSheetName - Current sheet name for cross-sheet reference matching
 * @param formulaSourceSheetName - Sheet where the formula is being edited
 */
export function getFormulaReferenceBorderAtPixel(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  formulaReferences: FormulaReference[],
  dimensions?: DimensionOverrides,
  currentSheetName?: string,
  formulaSourceSheetName?: string
): ReferenceBorderHit | null {
  if (!formulaReferences || formulaReferences.length === 0) {
    return null;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  // Skip if click is on headers
  if (pixelX < rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }

  const dims = ensureDimensions(dimensions);
  const range = calculateVisibleRange(viewport, config, pixelX + 100, pixelY + 100, dims);

  for (let i = 0; i < formulaReferences.length; i++) {
    const ref = formulaReferences[i];

    // Check if reference belongs to current sheet
    if (!shouldDrawReferenceOnSheet(ref.sheetName, currentSheetName, formulaSourceSheetName)) {
      continue;
    }

    // Skip passive references (from cell selection, not from editing)
    if (ref.isPassive) {
      continue;
    }

    // Normalize bounds
    const minRow = Math.min(ref.startRow, ref.endRow);
    const maxRow = Math.max(ref.startRow, ref.endRow);
    const minCol = Math.min(ref.startCol, ref.endCol);
    const maxCol = Math.max(ref.startCol, ref.endCol);

    // Calculate rectangle in viewport coordinates
    const x1 = getColumnX(minCol, config, dims, range.startCol, range.offsetX);
    const y1 = getRowY(minRow, config, dims, range.startRow, range.offsetY);

    let x2 = x1;
    for (let c = minCol; c <= maxCol; c++) {
      x2 += getColumnWidth(c, config, dims);
    }

    let y2 = y1;
    for (let r = minRow; r <= maxRow; r++) {
      y2 += getRowHeight(r, config, dims);
    }

    // Check if pixel is near the border (within threshold)
    const isNearLeftBorder = Math.abs(pixelX - x1) <= REFERENCE_BORDER_THRESHOLD && pixelY >= y1 && pixelY <= y2;
    const isNearRightBorder = Math.abs(pixelX - x2) <= REFERENCE_BORDER_THRESHOLD && pixelY >= y1 && pixelY <= y2;
    const isNearTopBorder = Math.abs(pixelY - y1) <= REFERENCE_BORDER_THRESHOLD && pixelX >= x1 && pixelX <= x2;
    const isNearBottomBorder = Math.abs(pixelY - y2) <= REFERENCE_BORDER_THRESHOLD && pixelX >= x1 && pixelX <= x2;

    if (isNearLeftBorder || isNearRightBorder || isNearTopBorder || isNearBottomBorder) {
      return { refIndex: i, reference: ref };
    }
  }

  return null;
}

/**
 * Result from getFormulaReferenceCornerAtPixel.
 */
export interface ReferenceCornerHit {
  /** Index of the reference in the array */
  refIndex: number;
  /** The reference that was hit */
  reference: FormulaReference;
  /** Which corner was hit */
  corner: ReferenceCorner;
}

/**
 * Check if a pixel position is on a corner handle of a formula reference.
 * Returns the reference info and corner if on a handle, null otherwise.
 * This is used for the reference resize feature - users can drag corner
 * handles to resize a reference range.
 *
 * Corner hits have HIGHER priority than border hits, so this should be
 * checked before getFormulaReferenceBorderAtPixel.
 */
export function getFormulaReferenceCornerAtPixel(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  formulaReferences: FormulaReference[],
  dimensions?: DimensionOverrides,
  currentSheetName?: string,
  formulaSourceSheetName?: string
): ReferenceCornerHit | null {
  if (!formulaReferences || formulaReferences.length === 0) {
    return null;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  // Skip if click is on headers
  if (pixelX < rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }

  const dims = ensureDimensions(dimensions);
  const range = calculateVisibleRange(viewport, config, pixelX + 100, pixelY + 100, dims);
  const hitHalf = Math.floor(REFERENCE_CORNER_HIT_SIZE / 2);

  for (let i = 0; i < formulaReferences.length; i++) {
    const ref = formulaReferences[i];

    // Check if reference belongs to current sheet
    if (!shouldDrawReferenceOnSheet(ref.sheetName, currentSheetName, formulaSourceSheetName)) {
      continue;
    }

    // Skip passive references
    if (ref.isPassive) {
      continue;
    }

    // Skip full column/row references (resize doesn't apply)
    if (ref.isFullColumn || ref.isFullRow) {
      continue;
    }

    // Normalize bounds
    const minRow = Math.min(ref.startRow, ref.endRow);
    const maxRow = Math.max(ref.startRow, ref.endRow);
    const minCol = Math.min(ref.startCol, ref.endCol);
    const maxCol = Math.max(ref.startCol, ref.endCol);

    // Calculate rectangle in viewport coordinates
    const x1 = getColumnX(minCol, config, dims, range.startCol, range.offsetX);
    const y1 = getRowY(minRow, config, dims, range.startRow, range.offsetY);

    let x2 = x1;
    for (let c = minCol; c <= maxCol; c++) {
      x2 += getColumnWidth(c, config, dims);
    }

    let y2 = y1;
    for (let r = minRow; r <= maxRow; r++) {
      y2 += getRowHeight(r, config, dims);
    }

    // Check each corner using the reference rectangle corners
    if (Math.abs(pixelX - x1) <= hitHalf && Math.abs(pixelY - y1) <= hitHalf) {
      return { refIndex: i, reference: ref, corner: "topLeft" };
    }
    if (Math.abs(pixelX - x2) <= hitHalf && Math.abs(pixelY - y1) <= hitHalf) {
      return { refIndex: i, reference: ref, corner: "topRight" };
    }
    if (Math.abs(pixelX - x1) <= hitHalf && Math.abs(pixelY - y2) <= hitHalf) {
      return { refIndex: i, reference: ref, corner: "bottomLeft" };
    }
    if (Math.abs(pixelX - x2) <= hitHalf && Math.abs(pixelY - y2) <= hitHalf) {
      return { refIndex: i, reference: ref, corner: "bottomRight" };
    }
  }

  return null;
}

/**
 * Check if a reference should be considered for hit testing on the current sheet.
 */
function shouldDrawReferenceOnSheet(
  refSheetName: string | undefined,
  currentSheetName: string | undefined,
  formulaSourceSheetName: string | undefined
): boolean {
  if (!refSheetName) {
    // Reference has no sheet prefix - it refers to the formula's source sheet
    if (!currentSheetName || !formulaSourceSheetName) return true;
    return currentSheetName.toLowerCase() === formulaSourceSheetName.toLowerCase();
  }
  // Reference has a sheet prefix - check if it matches current sheet
  if (!currentSheetName) return true;
  return refSheetName.toLowerCase() === currentSheetName.toLowerCase();
}

/**
 * Threshold in pixels for detecting mouse hover over selection border.
 */
const SELECTION_BORDER_THRESHOLD = 5;

/**
 * Result from getSelectionBorderAtPixel.
 */
export interface SelectionBorderHit {
  /** Which edge of the selection was hit */
  edge: "top" | "right" | "bottom" | "left";
}

/**
 * Check if a pixel position is on the border of the current selection.
 * Returns which edge was hit, or null if not on a border.
 * This is used for the selection dragging feature - users can drag
 * a selection by clicking on its border (like in Excel).
 *
 * IMPORTANT: For row/column selections, we check borders in the CELL AREA
 * (not the header area) to avoid conflicts with resize handles.
 * Header borders are reserved for resizing operations.
 *
 * @param pixelX - X coordinate in pixels relative to container
 * @param pixelY - Y coordinate in pixels relative to container
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param selection - Current selection to check
 * @param dimensions - Optional dimension overrides
 */
export function getSelectionBorderAtPixel(
  pixelX: number,
  pixelY: number,
  config: GridConfig,
  viewport: Viewport,
  selection: Selection | null,
  dimensions?: DimensionOverrides
): SelectionBorderHit | null {
  if (!selection) {
    return null;
  }

  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;

  // All selection types check borders in the CELL AREA (not headers)
  // This avoids conflicts with resize handles in the header areas
  if (pixelX < rowHeaderWidth || pixelY < colHeaderHeight) {
    return null;
  }

  const dims = ensureDimensions(dimensions);
  const range = calculateVisibleRange(viewport, config, pixelX + 100, pixelY + 100, dims);

  // Normalize bounds
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  // Calculate rectangle in viewport coordinates
  const x1 = getColumnX(minCol, config, dims, range.startCol, range.offsetX);
  const y1 = getRowY(minRow, config, dims, range.startRow, range.offsetY);

  let x2 = x1;
  for (let c = minCol; c <= maxCol; c++) {
    x2 += getColumnWidth(c, config, dims);
  }

  let y2 = y1;
  for (let r = minRow; r <= maxRow; r++) {
    y2 += getRowHeight(r, config, dims);
  }

  // For row selection, only check top/bottom borders
  if (selection.type === "rows") {
    const isNearTopBorder = Math.abs(pixelY - y1) <= SELECTION_BORDER_THRESHOLD && pixelX >= x1 && pixelX <= x2;
    const isNearBottomBorder = Math.abs(pixelY - y2) <= SELECTION_BORDER_THRESHOLD && pixelX >= x1 && pixelX <= x2;

    if (isNearTopBorder) return { edge: "top" };
    if (isNearBottomBorder) return { edge: "bottom" };

    return null;
  }

  // For column selection, only check left/right borders
  if (selection.type === "columns") {
    const isNearLeftBorder = Math.abs(pixelX - x1) <= SELECTION_BORDER_THRESHOLD && pixelY >= y1 && pixelY <= y2;
    const isNearRightBorder = Math.abs(pixelX - x2) <= SELECTION_BORDER_THRESHOLD && pixelY >= y1 && pixelY <= y2;

    if (isNearLeftBorder) return { edge: "left" };
    if (isNearRightBorder) return { edge: "right" };

    return null;
  }

  // For cell selection, check all four borders
  const isNearLeftBorder = Math.abs(pixelX - x1) <= SELECTION_BORDER_THRESHOLD && pixelY >= y1 && pixelY <= y2;
  const isNearRightBorder = Math.abs(pixelX - x2) <= SELECTION_BORDER_THRESHOLD && pixelY >= y1 && pixelY <= y2;
  const isNearTopBorder = Math.abs(pixelY - y1) <= SELECTION_BORDER_THRESHOLD && pixelX >= x1 && pixelX <= x2;
  const isNearBottomBorder = Math.abs(pixelY - y2) <= SELECTION_BORDER_THRESHOLD && pixelX >= x1 && pixelX <= x2;

  // Return the first border hit (priority: left, right, top, bottom)
  if (isNearLeftBorder) return { edge: "left" };
  if (isNearRightBorder) return { edge: "right" };
  if (isNearTopBorder) return { edge: "top" };
  if (isNearBottomBorder) return { edge: "bottom" };

  return null;
}