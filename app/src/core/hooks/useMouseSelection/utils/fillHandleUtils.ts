//! FILENAME: app/src/core/hooks/useMouseSelection/utils/fillHandleUtils.ts
// PURPOSE: Utility functions for fill handle cursor detection.
// CONTEXT: Contains functions for detecting when mouse is over the fill handle
// to change cursor style to crosshair.

import type { GridConfig, Viewport, Selection, DimensionOverrides } from "../../../types";
import { calculateVisibleRange, getColumnWidth, getRowHeight, getColumnX, getRowY } from "../../../lib/gridRenderer";
import { ensureDimensions } from "../../../lib/gridRenderer/styles/styleUtils";
import { getGridRegions } from "../../../../api/gridOverlays";

interface FillHandleCursorDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  selection: Selection | null;
}

/**
 * Creates a function to check if the mouse is over the fill handle.
 * The fill handle is the small square in the bottom-right corner of the selection.
 *
 * @param deps - Dependencies including config, viewport, dimensions, and selection
 * @returns A function that takes mouse coordinates and returns true if over fill handle
 */
export function createFillHandleCursorChecker(
  deps: FillHandleCursorDependencies
): (mouseX: number, mouseY: number) => boolean {
  const { config, viewport, dimensions, selection } = deps;

  return (mouseX: number, mouseY: number): boolean => {
    if (!selection) {
      return false;
    }

    // Block fill handle cursor when selection is inside a grid region (e.g., pivot table)
    const regions = getGridRegions();
    if (regions.length > 0) {
      const selMinRow = Math.min(selection.startRow, selection.endRow);
      const selMaxRow = Math.max(selection.startRow, selection.endRow);
      const selMinCol = Math.min(selection.startCol, selection.endCol);
      const selMaxCol = Math.max(selection.startCol, selection.endCol);
      for (const region of regions) {
        if (region.floating) continue;
        if (
          selMinRow >= region.startRow && selMaxRow <= region.endRow &&
          selMinCol >= region.startCol && selMaxCol <= region.endCol
        ) {
          return false;
        }
      }
    }

    const rowHeaderWidth = config.rowHeaderWidth || 50;
    const colHeaderHeight = config.colHeaderHeight || 24;

    // Ensure dimensions is defined
    const dims = ensureDimensions(dimensions);

    // Get the selection bounds
    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Calculate visible range (use a reasonable viewport size)
    const containerWidth = 2000;
    const containerHeight = 2000;
    const range = calculateVisibleRange(viewport, config, containerWidth, containerHeight, dims);

    // Check if the bottom-right cell of selection is visible
    if (
      maxRow < range.startRow ||
      maxRow > range.endRow ||
      maxCol < range.startCol ||
      maxCol > range.endCol
    ) {
      return false;
    }

    // Calculate the position of the bottom-right corner of the selection
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

    // The fill handle is drawn at the bottom-right corner with some offset
    // Match the drawing logic in selection.ts
    const handleSize = 8;
    const borderX2 = Math.min(x2, containerWidth) - 1;
    const borderY2 = Math.min(y2, containerHeight) - 1;
    const handleX = borderX2 - handleSize / 2;
    const handleY = borderY2 - handleSize / 2;

    // Check if the handle would be visible (past headers)
    if (handleX <= rowHeaderWidth || handleY <= colHeaderHeight) {
      return false;
    }

    // Check if mouse is within the fill handle area (with some padding for easier targeting)
    const hitPadding = 3;
    const handleLeft = handleX - handleSize / 2 - hitPadding;
    const handleRight = handleX + handleSize / 2 + hitPadding;
    const handleTop = handleY - handleSize / 2 - hitPadding;
    const handleBottom = handleY + handleSize / 2 + hitPadding;

    return (
      mouseX >= handleLeft &&
      mouseX <= handleRight &&
      mouseY >= handleTop &&
      mouseY <= handleBottom
    );
  };
}