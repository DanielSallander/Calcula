//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts
// PURPOSE: Factory function for creating overlay move handlers for floating overlays.
// CONTEXT: Detects when the mouse is on a floating overlay body and handles
//          drag-to-move. Dispatches generic "floatingObject:moveComplete" and
//          "floatingObject:selected" events so extensions can handle the logic.

import type { GridConfig, Viewport } from "../../../types";
import { getGridRegions, type GridRegion } from "../../../../api/gridOverlays";

// ============================================================================
// Overlay Move State
// ============================================================================

export interface OverlayMoveState {
  /** The region being moved */
  region: GridRegion;
  /** Mouse X at drag start (canvas pixels) */
  startMouseX: number;
  /** Mouse Y at drag start (canvas pixels) */
  startMouseY: number;
  /** Floating overlay X at drag start (sheet pixels) */
  startX: number;
  /** Floating overlay Y at drag start (sheet pixels) */
  startY: number;
  /** Current X position during drag (sheet pixels) */
  currentX: number;
  /** Current Y position during drag (sheet pixels) */
  currentY: number;
  /** Whether the mouse has actually moved (distinguishes click from drag) */
  hasMoved: boolean;
}

// ============================================================================
// Dependencies
// ============================================================================

interface OverlayMoveDependencies {
  config: GridConfig;
  viewport: Viewport;
  containerRef: React.RefObject<HTMLElement | null>;
  setIsOverlayMoving: (value: boolean) => void;
  setCursorStyle: (style: string) => void;
  overlayMoveStateRef: React.MutableRefObject<OverlayMoveState | null>;
}

// ============================================================================
// Handler Interface
// ============================================================================

export interface OverlayMoveHandlers {
  /** Check if mouse is over a floating overlay body. Returns the region or null. */
  checkOverlayBody: (mouseX: number, mouseY: number) => GridRegion | null;
  /** Handle mousedown on a floating overlay body. Returns true if move started. */
  handleOverlayMoveMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ) => boolean;
  /** Handle mousemove during overlay move drag. */
  handleOverlayMoveMouseMove: (mouseX: number, mouseY: number) => void;
  /** Handle mouseup to complete overlay move. */
  handleOverlayMoveMouseUp: () => void;
}

// ============================================================================
// Helper: Compute canvas bounds for a floating region
// ============================================================================

function getFloatingCanvasBounds(
  region: GridRegion,
  config: GridConfig,
  viewport: Viewport,
): { x: number; y: number; width: number; height: number } | null {
  if (!region.floating) return null;

  const rhw = config.rowHeaderWidth ?? 50;
  const chh = config.colHeaderHeight ?? 24;

  return {
    x: rhw + region.floating.x - viewport.scrollX,
    y: chh + region.floating.y - viewport.scrollY,
    width: region.floating.width,
    height: region.floating.height,
  };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates handlers for moving floating overlay regions via drag.
 * On mousedown over a floating overlay body, starts a move drag.
 * On mouseup, dispatches "floatingObject:moveComplete" with the final position.
 */
export function createOverlayMoveHandlers(
  deps: OverlayMoveDependencies,
): OverlayMoveHandlers {
  const {
    config,
    viewport,
    setIsOverlayMoving,
    setCursorStyle,
    overlayMoveStateRef,
  } = deps;

  /**
   * Check if mouse is over a floating overlay body.
   * Returns the region if found, or null.
   */
  const checkOverlayBody = (
    mouseX: number,
    mouseY: number,
  ): GridRegion | null => {
    const regions = getGridRegions();
    // Check in reverse so topmost floating overlays are tested first
    for (let i = regions.length - 1; i >= 0; i--) {
      const region = regions[i];
      const bounds = getFloatingCanvasBounds(region, config, viewport);
      if (!bounds) continue;

      if (
        mouseX >= bounds.x &&
        mouseX <= bounds.x + bounds.width &&
        mouseY >= bounds.y &&
        mouseY <= bounds.y + bounds.height
      ) {
        return region;
      }
    }
    return null;
  };

  /**
   * Handle mousedown on a floating overlay body.
   * Returns true if a move operation was started.
   */
  const handleOverlayMoveMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ): boolean => {
    const region = checkOverlayBody(mouseX, mouseY);
    if (!region || !region.floating) return false;

    event.preventDefault();
    setIsOverlayMoving(true);
    setCursorStyle("move");

    overlayMoveStateRef.current = {
      region,
      startMouseX: mouseX,
      startMouseY: mouseY,
      startX: region.floating.x,
      startY: region.floating.y,
      currentX: region.floating.x,
      currentY: region.floating.y,
      hasMoved: false,
    };

    // Notify extensions that a floating overlay was selected
    window.dispatchEvent(new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: region.id,
        regionType: region.type,
        data: region.data,
      },
    }));

    return true;
  };

  /**
   * Handle mousemove during overlay move drag.
   * Updates position and dispatches a live preview event.
   */
  const handleOverlayMoveMouseMove = (
    mouseX: number,
    mouseY: number,
  ): void => {
    const moveState = overlayMoveStateRef.current;
    if (!moveState) return;

    const deltaX = mouseX - moveState.startMouseX;
    const deltaY = mouseY - moveState.startMouseY;

    // Mark as moved if we've gone beyond a small threshold
    if (!moveState.hasMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      moveState.hasMoved = true;
    }

    // Clamp to non-negative sheet coordinates
    const newX = Math.max(0, moveState.startX + deltaX);
    const newY = Math.max(0, moveState.startY + deltaY);

    // Track current position for mouseUp
    moveState.currentX = newX;
    moveState.currentY = newY;

    // Dispatch live preview event
    window.dispatchEvent(new CustomEvent("floatingObject:movePreview", {
      detail: {
        regionId: moveState.region.id,
        regionType: moveState.region.type,
        data: moveState.region.data,
        x: newX,
        y: newY,
      },
    }));
  };

  /**
   * Handle mouseup to complete overlay move.
   * Dispatches "floatingObject:moveComplete" with the final position.
   */
  const handleOverlayMoveMouseUp = (): void => {
    const moveState = overlayMoveStateRef.current;
    if (!moveState) return;

    // Dispatch moveComplete with the final position
    if (moveState.hasMoved) {
      window.dispatchEvent(new CustomEvent("floatingObject:moveComplete", {
        detail: {
          regionId: moveState.region.id,
          regionType: moveState.region.type,
          data: moveState.region.data,
          x: moveState.currentX,
          y: moveState.currentY,
        },
      }));
    }

    setIsOverlayMoving(false);
    setCursorStyle("cell");
    overlayMoveStateRef.current = null;
  };

  return {
    checkOverlayBody,
    handleOverlayMoveMouseDown,
    handleOverlayMoveMouseMove,
    handleOverlayMoveMouseUp,
  };
}
