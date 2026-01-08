// FILENAME: app/src/hooks/useMouseSelection/utils/cellUtils.ts
// PURPOSE: Utility functions for cell position calculations during mouse selection.
// CONTEXT: Converts mouse positions to cell coordinates with optional midpoint threshold.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import { getCellFromPixel, type GetCellOptions } from "../../../lib/gridRenderer/interaction/hitTesting";

/**
 * Get cell coordinates from mouse position relative to container.
 * 
 * @param mouseX - Mouse X position relative to container
 * @param mouseY - Mouse Y position relative to container
 * @param rect - Container bounding rect (unused but kept for API consistency)
 * @param config - Grid configuration
 * @param viewport - Current viewport state
 * @param dimensions - Optional dimension overrides
 * @param options - Optional behavior options (e.g., midpoint threshold for drag)
 */
export function getCellFromMousePosition(
  mouseX: number,
  mouseY: number,
  _rect: DOMRect,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides,
  options?: GetCellOptions
): { row: number; col: number } | null {
  return getCellFromPixel(mouseX, mouseY, config, viewport, dimensions, options);
}

/**
 * Get the current size of a dimension (column width or row height).
 */
export function getCurrentDimensionSize(
  index: number,
  isColumn: boolean,
  config: GridConfig,
  dimensions?: DimensionOverrides
): number {
  if (isColumn) {
    return dimensions?.columnWidths?.get(index) ?? config.defaultCellWidth;
  }
  return dimensions?.rowHeights?.get(index) ?? config.defaultCellHeight;
}