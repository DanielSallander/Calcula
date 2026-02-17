//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayResizeHandlers.ts
// PURPOSE: Factory function for creating overlay region resize handlers.
// CONTEXT: Detects when the mouse is near a resize handle of an overlay region
//          (e.g., table or floating chart) and handles drag-to-resize.
//          For cell-based overlays: dispatches "overlay:resizeComplete".
//          For floating overlays: dispatches "floatingObject:resizeComplete".

import type { GridConfig, Viewport, DimensionOverrides } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";
import { getGridRegions, type GridRegion } from "../../../../api/gridOverlays";
import { getCellFromPixel } from "../../../lib/gridRenderer";

/** Size of the resize handle hit area in pixels */
const HANDLE_HIT_SIZE = 10;

/** Minimum floating overlay size in pixels */
const MIN_FLOATING_SIZE = 50;

/** Which corner or edge is being dragged */
type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

// ============================================================================
// Overlay Resize State
// ============================================================================

interface OverlayResizeState {
  /** The region being resized */
  region: GridRegion;
  /** Current target end row during drag (cell-based overlays) */
  currentEndRow: number;
  /** Current target end col during drag (cell-based overlays) */
  currentEndCol: number;
  /** For floating overlays: which corner is being dragged */
  corner?: ResizeCorner;
  /** For floating overlays: current bounds during drag */
  floatingBounds?: { x: number; y: number; width: number; height: number };
  /** For floating overlays: mouse position at drag start */
  startMouseX?: number;
  startMouseY?: number;
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
// Helper: Calculate pixel position of overlay bottom-right corner (cell-based)
// ============================================================================

function getOverlayBottomRightPixel(
  region: GridRegion,
  config: GridConfig,
  viewport: Viewport,
  dimensions?: DimensionOverrides,
): { x: number; y: number } | null {
  if (region.floating) return null; // Use floating-specific logic instead

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
// Helper: Get all 4 corner pixel positions for a floating overlay
// ============================================================================

function getFloatingCornerPixels(
  region: GridRegion,
  config: GridConfig,
  viewport: Viewport,
): { corner: ResizeCorner; x: number; y: number; cursor: string }[] | null {
  if (!region.floating) return null;

  const rhw = config.rowHeaderWidth ?? 50;
  const chh = config.colHeaderHeight ?? 24;
  const f = region.floating;

  const left = rhw + f.x - viewport.scrollX;
  const top = chh + f.y - viewport.scrollY;
  const right = left + f.width;
  const bottom = top + f.height;

  return [
    { corner: "top-left", x: left, y: top, cursor: "nwse-resize" },
    { corner: "top-right", x: right, y: top, cursor: "nesw-resize" },
    { corner: "bottom-left", x: left, y: bottom, cursor: "nesw-resize" },
    { corner: "bottom-right", x: right, y: bottom, cursor: "nwse-resize" },
  ];
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates handlers for overlay region resize operations.
 * Supports both cell-based overlays (tables) and floating overlays (charts).
 * For cell-based: detects bottom-right corner, dispatches "overlay:resizeComplete".
 * For floating: detects all 4 corners, dispatches "floatingObject:resizeComplete".
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
   * Check if mouse is near a resize handle of any overlay region.
   * For cell-based: checks bottom-right corner only.
   * For floating: checks all 4 corners.
   * Returns the region if found, or null.
   */
  const checkOverlayResizeHandle = (
    mouseX: number,
    mouseY: number,
  ): GridRegion | null => {
    const regions = getGridRegions();
    for (const region of regions) {
      // Floating overlay: check all 4 corners
      if (region.floating) {
        const corners = getFloatingCornerPixels(region, config, viewport);
        if (!corners) continue;

        for (const c of corners) {
          const dx = Math.abs(mouseX - c.x);
          const dy = Math.abs(mouseY - c.y);
          if (dx <= HANDLE_HIT_SIZE && dy <= HANDLE_HIT_SIZE) {
            return region;
          }
        }
        continue;
      }

      // Cell-based overlay: check bottom-right corner only
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
    const regions = getGridRegions();

    // Check floating overlays first (all 4 corners)
    for (const region of regions) {
      if (!region.floating) continue;

      const corners = getFloatingCornerPixels(region, config, viewport);
      if (!corners) continue;

      for (const c of corners) {
        const dx = Math.abs(mouseX - c.x);
        const dy = Math.abs(mouseY - c.y);
        if (dx <= HANDLE_HIT_SIZE && dy <= HANDLE_HIT_SIZE) {
          event.preventDefault();
          setIsOverlayResizing(true);
          setCursorStyle(c.cursor);
          overlayResizeStateRef.current = {
            region,
            currentEndRow: 0,
            currentEndCol: 0,
            corner: c.corner,
            floatingBounds: { ...region.floating },
            startMouseX: mouseX,
            startMouseY: mouseY,
          };
          return true;
        }
      }
    }

    // Check cell-based overlays (bottom-right corner only)
    const region = checkOverlayResizeHandle(mouseX, mouseY);
    if (!region || region.floating) return false;

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
   */
  const handleOverlayResizeMouseMove = (
    mouseX: number,
    mouseY: number,
  ): void => {
    const resizeState = overlayResizeStateRef.current;
    if (!resizeState) return;

    // Floating overlay resize
    if (resizeState.corner && resizeState.floatingBounds && resizeState.startMouseX != null) {
      const deltaX = mouseX - resizeState.startMouseX!;
      const deltaY = mouseY - resizeState.startMouseY!;
      const orig = resizeState.region.floating!;
      const bounds = resizeState.floatingBounds;

      switch (resizeState.corner) {
        case "bottom-right":
          bounds.width = Math.max(MIN_FLOATING_SIZE, orig.width + deltaX);
          bounds.height = Math.max(MIN_FLOATING_SIZE, orig.height + deltaY);
          break;
        case "bottom-left":
          {
            const newWidth = Math.max(MIN_FLOATING_SIZE, orig.width - deltaX);
            bounds.x = orig.x + (orig.width - newWidth);
            bounds.width = newWidth;
            bounds.height = Math.max(MIN_FLOATING_SIZE, orig.height + deltaY);
          }
          break;
        case "top-right":
          {
            const newHeight = Math.max(MIN_FLOATING_SIZE, orig.height - deltaY);
            bounds.y = orig.y + (orig.height - newHeight);
            bounds.height = newHeight;
            bounds.width = Math.max(MIN_FLOATING_SIZE, orig.width + deltaX);
          }
          break;
        case "top-left":
          {
            const newWidth = Math.max(MIN_FLOATING_SIZE, orig.width - deltaX);
            const newHeight = Math.max(MIN_FLOATING_SIZE, orig.height - deltaY);
            bounds.x = orig.x + (orig.width - newWidth);
            bounds.y = orig.y + (orig.height - newHeight);
            bounds.width = newWidth;
            bounds.height = newHeight;
          }
          break;
      }

      // Clamp position to non-negative
      bounds.x = Math.max(0, bounds.x);
      bounds.y = Math.max(0, bounds.y);

      window.dispatchEvent(new CustomEvent("floatingObject:resizePreview", {
        detail: {
          regionId: resizeState.region.id,
          regionType: resizeState.region.type,
          data: resizeState.region.data,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
      }));
      return;
    }

    // Cell-based overlay resize (original logic)
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
   */
  const handleOverlayResizeMouseUp = (): void => {
    const resizeState = overlayResizeStateRef.current;
    if (!resizeState) return;

    // Floating overlay resize complete
    if (resizeState.corner && resizeState.floatingBounds) {
      const orig = resizeState.region.floating!;
      const bounds = resizeState.floatingBounds;

      // Only dispatch if bounds actually changed
      if (
        bounds.x !== orig.x ||
        bounds.y !== orig.y ||
        bounds.width !== orig.width ||
        bounds.height !== orig.height
      ) {
        window.dispatchEvent(new CustomEvent("floatingObject:resizeComplete", {
          detail: {
            regionId: resizeState.region.id,
            regionType: resizeState.region.type,
            data: resizeState.region.data,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
        }));
      }

      setIsOverlayResizing(false);
      setCursorStyle("cell");
      overlayResizeStateRef.current = null;
      return;
    }

    // Cell-based overlay resize complete (original logic)
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
