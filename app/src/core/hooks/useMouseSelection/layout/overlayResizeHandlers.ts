//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayResizeHandlers.ts
// PURPOSE: Factory function for creating overlay region resize handlers.
// CONTEXT: Detects when the mouse is near a resize handle of an overlay region
//          (e.g., table or floating chart) and handles drag-to-resize.
//          For cell-based overlays: dispatches "overlay:resizeComplete".
//          For floating overlays: dispatches "floatingObject:resizeComplete".

import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";
import {
  getGridRegions,
  floatingHitOrder,
  hasStackingOrder,
  type GridRegion,
} from "../../../../api/gridOverlays";
import { getCellFromPixel } from "../../../lib/gridRenderer";
import { rowHeaderGutter, colHeaderGutter } from "../../../lib/gridRenderer/layout/headerVisibility";
import { getLayoutSurface, applySurfaceToResize, edgesOfCorner, isRegionLocked } from "../../../lib/layoutSurface";
import { getGridStateSnapshot } from "../../../state/GridContext";
import { isGlobalFormulaMode } from "../../useEditing";
import { getExternalFormulaTarget } from "../../../lib/formulaEditTarget";

/** The layout surface of the sheet being edited (null = unconstrained). */
function activeLayoutSurface() {
  return getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
}

/** False in consume mode: no resize handle is live on any floating object. */
function floatingResizeAllowed(): boolean {
  const surface = activeLayoutSurface();
  return !surface || surface.editable;
}

/**
 * Whether ONE floating region's handles are live: its family did not set
 * `resizable: false`, and the layout surface does not LOCK it. A locked
 * object still occludes what lies beneath it and a press still selects it --
 * only its geometry is frozen.
 */
function floatingResizable(region: GridRegion): boolean {
  if (region.data?.resizable === false) return false;
  return !isRegionLocked(activeLayoutSurface(), region);
}

/**
 * Whether a formula is PICKING a reference right now -- in the grid's own
 * editor, or in an extension's external editor (a floating grid's cell
 * editor, @api/editing). A press on a floating object then belongs to the
 * object's reference pick, which only its owner's `claimsBodyDrag` knows
 * how to make; the resize scan runs BEFORE the move path, so a live corner
 * box would swallow the pick and start a resize instead.
 */
function referencePickActive(): boolean {
  return isGlobalFormulaMode() || getExternalFormulaTarget()?.isExpectingReference() === true;
}

/**
 * Whether a press landed on a real, editable DOM control stacked on the
 * canvas (the floating grid's cell editor <textarea> is the live example).
 * The corner boxes are pure GEOMETRY and never look at what the mouse landed
 * on; claiming such a press would preventDefault the control's own caret
 * placement. The same rule `handleOverlayMoveMouseDown` applies.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/** Size of the resize handle hit area in pixels */
const HANDLE_HIT_SIZE = 10;

/** Minimum floating overlay size in pixels */
const MIN_FLOATING_SIZE = 16;

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
  freezeConfig?: FreezeConfig;
  splitBarSize?: number;
  splitViewport?: Viewport;
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
  /** `altKey` held = resize freely, bypassing the snap grid. */
  handleOverlayResizeMouseMove: (mouseX: number, mouseY: number, altKey?: boolean) => void;
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

  const rowHeaderWidth = rowHeaderGutter(config);
  const colHeaderHeight = colHeaderGutter(config);
  const defaultCellWidth = config.defaultCellWidth || 100;
  const defaultCellHeight = config.defaultCellHeight || 20;
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

type FloatingCorner = { corner: ResizeCorner; x: number; y: number; cursor: string };

/**
 * The floating resize handle under the point while a STACKING ORDER is in
 * force (@api/gridOverlays `hasStackingOrder`), or null.
 *
 * Walks `floatingHitOrder` (topmost first) and STOPS at the first region whose
 * body contains the point: a handle of an object covered by another must not
 * be grabbable through the object on top. A region's own handles -- which
 * reach HANDLE_HIT_SIZE past its edge -- are tested before its body occludes,
 * and a region that cannot be resized still occludes what lies beneath it.
 *
 * Without a stacking order the historical forward scan runs instead, unchanged.
 */
function findStackedFloatingHandle(
  mouseX: number,
  mouseY: number,
  config: GridConfig,
  viewport: Viewport,
  floatingAllowed: boolean,
): { region: GridRegion; corner: FloatingCorner } | null {
  for (const region of floatingHitOrder(getGridRegions())) {
    const corners = getFloatingCornerPixels(region, config, viewport);
    if (!corners) continue;
    if (floatingAllowed && floatingResizable(region)) {
      for (const c of corners) {
        if (Math.abs(mouseX - c.x) <= HANDLE_HIT_SIZE && Math.abs(mouseY - c.y) <= HANDLE_HIT_SIZE) {
          return { region, corner: c };
        }
      }
    }
    const f = region.floating!;
    const left = corners[0].x;
    const top = corners[0].y;
    if (mouseX >= left && mouseX <= left + f.width && mouseY >= top && mouseY <= top + f.height) {
      return null; // occluded: nothing beneath this object is reachable here
    }
  }
  return null;
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
    freezeConfig,
    splitBarSize,
    splitViewport,
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
    // No floating handle is live in consume mode, nor while a formula is
    // picking a reference (the hover cursor must not promise a resize the
    // press will not start).
    const floatingAllowed = floatingResizeAllowed() && !referencePickActive();

    // Stacking order in force: floating handles topmost first, occlusion
    // respected; then the cell-anchored regions, scanned exactly as before.
    if (hasStackingOrder(regions)) {
      const stacked = findStackedFloatingHandle(mouseX, mouseY, config, viewport, floatingAllowed);
      if (stacked) return stacked.region;
      for (const region of regions) {
        if (region.floating) continue;
        const corner = getOverlayBottomRightPixel(region, config, viewport, dimensions);
        if (!corner) continue;
        if (Math.abs(mouseX - corner.x) <= HANDLE_HIT_SIZE && Math.abs(mouseY - corner.y) <= HANDLE_HIT_SIZE) {
          return region;
        }
      }
      return null;
    }

    for (const region of regions) {
      // Floating overlay: check all 4 corners
      if (region.floating) {
        // Skip if region is not resizable (or the surface is in consume mode)
        if (!floatingAllowed || !floatingResizable(region)) continue;

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

    // Check floating overlays first (all 4 corners). None is live in consume
    // mode (a subscribed canvas), while a formula is picking a reference, or
    // for a press that landed on an editable control stacked on the canvas --
    // the last two mirror the move path, which the resize scan runs BEFORE.
    const floatingAllowed =
      floatingResizeAllowed() && !referencePickActive() && !isEditableTarget(event.target);

    // Stacking order in force: topmost first, and a handle covered by another
    // object is not grabbable through it (findStackedFloatingHandle). The
    // historical forward scan below then has nothing left to do.
    const stackingOrder = hasStackingOrder(regions);
    if (stackingOrder) {
      const stacked = findStackedFloatingHandle(mouseX, mouseY, config, viewport, floatingAllowed);
      if (stacked) {
        const { region, corner: c } = stacked;
        event.preventDefault();
        setIsOverlayResizing(true);
        setCursorStyle(c.cursor);
        overlayResizeStateRef.current = {
          region,
          currentEndRow: 0,
          currentEndCol: 0,
          corner: c.corner,
          floatingBounds: { ...region.floating! },
          startMouseX: mouseX,
          startMouseY: mouseY,
        };
        return true;
      }
    }

    for (const region of stackingOrder ? [] : regions) {
      if (!region.floating) continue;
      // Skip if region is not resizable (extensions set this via data)
      if (!floatingAllowed || !floatingResizable(region)) continue;

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
    altKey: boolean = false,
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

      // Clamp position to non-negative WITHOUT moving the fixed edge: a
      // left/top drag past the sheet origin shrinks the object at 0 instead of
      // pushing its right/bottom edge outward (the old clamp did the latter).
      if (bounds.x < 0) {
        bounds.width = Math.max(MIN_FLOATING_SIZE, bounds.width + bounds.x);
        bounds.x = 0;
      }
      if (bounds.y < 0) {
        bounds.height = Math.max(MIN_FLOATING_SIZE, bounds.height + bounds.y);
        bounds.y = 0;
      }

      // SNAP + PAGE (the layout surface): only the DRAGGED edges snap, the
      // fixed corner stays put, MIN_FLOATING_SIZE still holds, and dragged
      // edges stop at the page border. Mouse-up re-dispatches these bounds as
      // resizeComplete, so preview and result agree. Alt resizes freely.
      const surface = activeLayoutSurface();
      if (surface) {
        const snapped = applySurfaceToResize(
          surface,
          { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          edgesOfCorner(resizeState.corner),
          MIN_FLOATING_SIZE,
          {
            bypassSnap: altKey,
            // `snap: false` opts a family out of snapping altogether;
            // `snapResize: false` only out of RESIZE snapping, for a family that
            // quantises its own size (a floating range resizes by whole rows
            // and columns) but still aligns its position to the grid.
            optOutSnap:
              resizeState.region.data?.snap === false ||
              resizeState.region.data?.snapResize === false,
          },
        );
        bounds.x = snapped.x;
        bounds.y = snapped.y;
        bounds.width = snapped.width;
        bounds.height = snapped.height;
      }

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

    const cell = getCellFromPixel(mouseX, mouseY, config, viewport, dimensions, { freezeConfig, splitBarSize, splitViewport });
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
