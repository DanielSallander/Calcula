//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayResizeHandlers.ts
// PURPOSE: Factory function for creating overlay region resize handlers.
// CONTEXT: Detects when the mouse is near the bottom-right resize handle of
//          an overlay region (e.g., table) and handles drag-to-resize.
//          Dispatches a generic "overlay:resizeComplete" event so extensions
//          can handle the actual resize logic.

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";
import { getGridRegions, type GridRegion } from "../../../../api/gridOverlays";
import { getCellFromPixel } from "../../../lib/gridRenderer";

/** Size of the resize handle hit area in pixels */
const HANDLE_HIT_SIZE = 10;

// ============================================================================
// Overlay Resize State
// ============================================================================

interface OverlayResizeState {
  /** The region being resized */
  region: GridRegion;
  /** Current target end row during drag */
  currentEndRow: number;
  /** Current target end col during drag */
  currentEndCol: number;
}

// ============================================================================
// Dependencies
// ============================================================================

interface OverlayResizeDependencies {
  config: GridConfig;
  viewport: Viewport;
  dimensions?: DimensionOverrides;
  containerRef: React.RefObject<HTMLElement | null>;
  setIsOverlayResizing: (value: boolean) => void;
  setCursorStyle: (style: string) => void;
  overlayResizeStateRef: React.MutableRefObject<OverlayResizeState | null>;
}

// ============================================================================
// Handler Interface
// ============================================================================

export interface OverlayResizeHandlers {
  /** Check if mouse is over an overlay resize handle */
  checkOverlayResizeHandle: (mouseX: number, mouseY: number) => GridRegion | null;
  /** Handle mousedown on an overlay resize handle. Returns true if resize started. */
  handleOverlayResizeMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>
  ) => boolean;
  /** Handle mousemove during overlay resize drag */
  handleOverlayResizeMouseMove: (mouseX: number, mouseY: number) => void;
  /** Handle mouseup to complete overlay resize */
  handleOverlayResizeMouseUp: () => void;
}

// ============================================================================
// Helper: Calculate pixel position of overlay bottom-right corner
// ============================================================================

function getOverlayBottomRightPixel(
  region: GridRegion,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides,
): { x: number; y: number } | null {
  const rowHeaderWidth = config.rowHeaderWidth || 50;
  const colHeaderHeight = config.colHeaderHeight || 24;
  const defaultCellWidth = config.defaultCellWidth || 100;
  const defaultCellHeight = config.defaultCellHeight || 24;
  const dims = dimensions || createEmptyDimensionOverrides();

  // Calculate X position of the right edge of endCol
  let x = rowHeaderWidth;
  for (let c = 0; c <= region.endCol; c++) {
    const customWidth = dims.columnWidths.get(c);
    x += (customWidth !== undefined && customWidth > 0) ? customWidth : defaultCellWidth;
  }
  x -= viewport.scrollX;

  // Calculate Y position of the bottom edge of endRow
  let y = colHeaderHeight;
  for (let r = 0; r <= region.endRow; r++) {
    const customHeight = dims.rowHeights.get(r);
    y += (customHeight !== undefined && customHeight > 0) ? customHeight : defaultCellHeight;
  }
  y -= viewport.scrollY;

  return { x, y };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates handlers for overlay region resize operations.
 * The handlers detect when the mouse is near the bottom-right corner of any
 * overlay region, and handle drag-to-resize by tracking the target cell.
 * On completion, dispatches an "overlay:resizeComplete" event.
 */
export function createOverlayResizeHandlers(
  deps: OverlayResizeDependencies
): OverlayResizeHandlers {
  const {
    config,
    viewport,
    dimensions,
    containerRef,
    setIsOverlayResizing,
    setCursorStyle,
    overlayResizeStateRef,
  } = deps;

  /**
   * Check if mouse is near the bottom-right corner of any overlay region.
   * Returns the region if found, or null.
   */
  const checkOverlayResizeHandle = (
    mouseX: number,
    mouseY: number,
  ): GridRegion | null => {
    const regions = getGridRegions();
    for (const region of regions) {
      const corner = getOverlayBottomRightPixel(region, config, viewport, dimensions);
      if (!corner) continue;

      const dx = Math.abs(mouseX - corner.x);
      const dy = Math.abs(mouseY - corner.y);

      if (dx <= HANDLE_HIT_SIZE && dy <= HANDLE_HIT_SIZE) {
        return region;
      }
    }
    return null;
  };

  /**
   * Handle mousedown on an overlay resize handle.
   * Returns true if a resize operation was started.
   */
  const handleOverlayResizeMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ): boolean => {
    const region = checkOverlayResizeHandle(mouseX, mouseY);
    if (!region) return false;

    event.preventDefault();
    setIsOverlayResizing(true);
    setCursorStyle("nwse-resize");
    overlayResizeStateRef.current = {
      region,
      currentEndRow: region.endRow,
      currentEndCol: region.endCol,
    };
    return true;
  };

  /**
   * Handle mousemove during overlay resize drag.
   * Updates the overlay region preview and dispatches a live update event.
   */
  const handleOverlayResizeMouseMove = (
    mouseX: number,
    mouseY: number,
  ): void => {
    const resizeState = overlayResizeStateRef.current;
    if (!resizeState) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions);
    if (!cell) return;

    // Ensure we don't shrink past the start position
    const newEndRow = Math.max(cell.row, resizeState.region.startRow);
    const newEndCol = Math.max(cell.col, resizeState.region.startCol);

    resizeState.currentEndRow = newEndRow;
    resizeState.currentEndCol = newEndCol;

    // Dispatch live preview event so the overlay renderer can show the new bounds
    window.dispatchEvent(new CustomEvent("overlay:resizePreview", {
      detail: {
        regionId: resizeState.region.id,
        regionType: resizeState.region.type,
        endRow: newEndRow,
        endCol: newEndCol,
      },
    }));
  };

  /**
   * Handle mouseup to complete overlay resize.
   * Dispatches "overlay:resizeComplete" event with the final bounds.
   */
  const handleOverlayResizeMouseUp = (): void => {
    const resizeState = overlayResizeStateRef.current;
    if (!resizeState) return;

    const { region, currentEndRow, currentEndCol } = resizeState;

    // Only dispatch if bounds actually changed
    if (currentEndRow !== region.endRow || currentEndCol !== region.endCol) {
      window.dispatchEvent(new CustomEvent("overlay:resizeComplete", {
        detail: {
          regionId: region.id,
          regionType: region.type,
          data: region.data,
          startRow: region.startRow,
          startCol: region.startCol,
          endRow: currentEndRow,
          endCol: currentEndCol,
        },
      }));
    }

    setIsOverlayResizing(false);
    setCursorStyle("cell");
    overlayResizeStateRef.current = null;
  };

  return {
    checkOverlayResizeHandle,
    handleOverlayResizeMouseDown,
    handleOverlayResizeMouseMove,
    handleOverlayResizeMouseUp,
  };
}
