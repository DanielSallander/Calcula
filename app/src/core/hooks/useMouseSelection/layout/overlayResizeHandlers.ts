//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayResizeHandlers.ts
// PURPOSE: Factory function for creating overlay region resize handlers.
// CONTEXT: Detects when the mouse is near a resize handle of an overlay region
//          (e.g., table or floating chart) and handles drag-to-resize.
//          For cell-based overlays: dispatches "overlay:resizeComplete".
//          For floating overlays: dispatches "floatingObject:resizeComplete".
//
//          FLOATING HANDLES (BUG-0258 design phase 3) come from ONE geometry,
//          core/lib/floatingHandles.ts, which Core's selection-chrome painter
//          reads too: a handle is live only on a SELECTED object (never in
//          consume mode, on a locked object or while a formula is picking a
//          reference), it is hit exactly where it is painted, all eight resize
//          (each drags its own sides -- the right-edge handle changes the width
//          only), and each shows its own pointer.

import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";
import { getGridRegions, type GridRegion } from "../../../../api/gridOverlays";
import { getCellFromPixel } from "../../../lib/gridRenderer";
import { rowHeaderGutter, colHeaderGutter } from "../../../lib/gridRenderer/layout/headerVisibility";
import { getLayoutSurface, applySurfaceToResize, type DraggedEdges } from "../../../lib/layoutSurface";
import { getGridStateSnapshot } from "../../../state/GridContext";
import { isGlobalFormulaMode } from "../../useEditing";
import {
  floatingHandleAt,
  registerGridReferencePickProbe,
  type FloatingHandleId,
} from "../../../lib/floatingHandles";
import { setFloatingGestureActive } from "../../../lib/objectHover";

// The GRID editor's "a formula is picking a reference" answer, handed to the
// one handle geometry: the renderer that paints the handles cannot import
// useEditing (useEditing imports the renderer), and this module -- which owns
// the press -- already depends on it. While a pick is live no handle is: the
// press belongs to the object's reference pick, which only its owner's content
// zone (`zoneAt`) knows how to make, and the resize scan runs BEFORE the move
// path, so a live handle would swallow the pick and start a resize instead.
registerGridReferencePickProbe(isGlobalFormulaMode);

/** The layout surface of the sheet being edited (null = unconstrained). */
function activeLayoutSurface() {
  return getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
}

/**
 * Whether a press landed on a real, editable DOM control stacked on the
 * canvas (the floating grid's cell editor <textarea> is the live example).
 * The handles are pure GEOMETRY and never look at what the mouse landed on;
 * claiming such a press would preventDefault the control's own caret
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

/**
 * Hit half-size, in px, of a CELL-ANCHORED region's bottom-right handle (a
 * table). Floating objects use the one handle geometry instead.
 */
const CELL_HANDLE_HIT_SIZE = 10;

/** Minimum floating overlay size in pixels */
const MIN_FLOATING_SIZE = 16;

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
  /** For floating overlays: the handle being dragged */
  handle?: FloatingHandleId;
  /** For floating overlays: the sides that handle drags */
  edges?: DraggedEdges;
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

/** A resize handle under the pointer: its object, and the pointer it shows. */
export interface OverlayResizeHit {
  region: GridRegion;
  /** The handle's own pointer (per corner and edge); "nwse-resize" for a cell-anchored region. */
  cursor: string;
}

export interface OverlayResizeHandlers {
  /** Check if mouse is over an overlay resize handle */
  checkOverlayResizeHandle: (mouseX: number, mouseY: number) => OverlayResizeHit | null;
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
// Factory
// ============================================================================

/**
 * Creates handlers for overlay region resize operations.
 * Supports both cell-based overlays (tables) and floating overlays (charts).
 * For cell-based: detects bottom-right corner, dispatches "overlay:resizeComplete".
 * For floating: the live handles of a SELECTED object (core/lib/floatingHandles.ts
 * -- eight, or the four corners for a region publishing `handles: "corners"`),
 * dispatches "floatingObject:resizeComplete".
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

  /** Where the floating handles sit: the painted gutters and the scroll. */
  const gutters = { rowHeaderWidth: rowHeaderGutter(config), colHeaderHeight: colHeaderGutter(config) };
  const scroll = { scrollX: viewport.scrollX, scrollY: viewport.scrollY };

  /**
   * Check if mouse is near a resize handle of any overlay region.
   * For floating: the live handles of SELECTED objects, topmost first
   * (`floatingHandleAt`) -- none in consume mode, on a locked object or while
   * a formula is picking a reference, so the hover pointer never promises a
   * resize the press will not start.
   * For cell-based: checks bottom-right corner only.
   * Returns the region and the handle's own pointer, or null.
   */
  const checkOverlayResizeHandle = (
    mouseX: number,
    mouseY: number,
  ): OverlayResizeHit | null => {
    const regions = getGridRegions();
    const floating = floatingHandleAt(mouseX, mouseY, gutters, scroll, regions);
    if (floating) return { region: floating.region, cursor: floating.handle.cursor };

    for (const region of regions) {
      if (region.floating) continue;
      // Cell-based overlay: check bottom-right corner only
      const corner = getOverlayBottomRightPixel(region, config, viewport, dimensions);
      if (!corner) continue;
      if (
        Math.abs(mouseX - corner.x) <= CELL_HANDLE_HIT_SIZE &&
        Math.abs(mouseY - corner.y) <= CELL_HANDLE_HIT_SIZE
      ) {
        return { region, cursor: "nwse-resize" };
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

    // Floating objects first: a live handle of a SELECTED object, topmost
    // first (`floatingHandleAt`: none in consume mode, on a locked object or
    // while a formula is picking a reference). Never for a press that landed on
    // an editable control stacked on the canvas -- that mirrors the move path,
    // which the resize scan runs BEFORE.
    const floating = isEditableTarget(event.target)
      ? null
      : floatingHandleAt(mouseX, mouseY, gutters, scroll, regions);
    if (floating) {
      const { region, handle } = floating;
      event.preventDefault();
      setIsOverlayResizing(true);
      setCursorStyle(handle.cursor);
      // A Core floating GESTURE until the release: no grip shows during a
      // resize (core/lib/objectHover.ts, core/lib/floatingGrip.ts).
      setFloatingGestureActive(true);
      overlayResizeStateRef.current = {
        region,
        currentEndRow: 0,
        currentEndCol: 0,
        handle: handle.id,
        edges: handle.edges,
        floatingBounds: { ...region.floating! },
        startMouseX: mouseX,
        startMouseY: mouseY,
      };
      return true;
    }

    // Check cell-based overlays (bottom-right corner only)
    const hit = checkOverlayResizeHandle(mouseX, mouseY);
    const region = hit?.region;
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
    if (resizeState.edges && resizeState.floatingBounds && resizeState.startMouseX != null) {
      const deltaX = mouseX - resizeState.startMouseX!;
      const deltaY = mouseY - resizeState.startMouseY!;
      const orig = resizeState.region.floating!;
      const edges = resizeState.edges;
      const bounds = resizeState.floatingBounds;

      // Each DRAGGED side follows the pointer and MIN_FLOATING_SIZE holds from
      // the opposite side; a side the handle does not drag never moves (the
      // right-edge handle changes the width only, the top-edge handle the top
      // and the height with the bottom fixed).
      let left = orig.x;
      let top = orig.y;
      let right = orig.x + orig.width;
      let bottom = orig.y + orig.height;
      if (edges.left) left = Math.min(orig.x + deltaX, right - MIN_FLOATING_SIZE);
      if (edges.right) right = Math.max(orig.x + orig.width + deltaX, left + MIN_FLOATING_SIZE);
      if (edges.top) top = Math.min(orig.y + deltaY, bottom - MIN_FLOATING_SIZE);
      if (edges.bottom) bottom = Math.max(orig.y + orig.height + deltaY, top + MIN_FLOATING_SIZE);
      bounds.x = left;
      bounds.y = top;
      bounds.width = right - left;
      bounds.height = bottom - top;

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
          edges,
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
    if (resizeState.edges && resizeState.floatingBounds) {
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
      setFloatingGestureActive(false);
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
