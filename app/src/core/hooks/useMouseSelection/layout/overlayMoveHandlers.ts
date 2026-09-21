//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts
// PURPOSE: Factory function for creating overlay move handlers for floating overlays.
// CONTEXT: Detects when the mouse is on a floating overlay body and handles
//          drag-to-move. Dispatches generic "floatingObject:moveComplete" and
//          "floatingObject:selected" events so extensions can handle the logic.
//          Also offers a DOUBLE-CLICK on a floating overlay to that overlay's
//          owner via OverlayRegistration.onDoubleClick (@api/gridOverlays) -- the
//          only seam that can reach an extension over a floating object, since
//          the cell double-click interceptors are asked about a CELL.

import type { GridConfig, Viewport } from "../../../types";
import { getGridRegions, getOverlayRegistration, type GridRegion } from "../../../../api/gridOverlays";
import { isPointerClaimed } from "../../../lib/pointerClaims";

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
  /** Check if mouse is over a floating overlay body. Returns the region and optional cursor hint. */
  checkOverlayBody: (mouseX: number, mouseY: number) => { region: GridRegion; cursor: string | null } | null;
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
  /**
   * Offer a double-click that landed on a floating overlay to that overlay's
   * owner (`OverlayRegistration.onDoubleClick`). Returns true when the owner
   * took the gesture; false when nothing claimed it, in which case the grid
   * does what it has always done over a floating object -- nothing.
   */
  handleOverlayDoubleClick: (
    region: GridRegion,
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ) => boolean;
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

/**
 * Find the topmost floating overlay region containing the given mouse
 * position (zoom-corrected canvas coordinates — the same basis
 * checkOverlayBody uses). Plain bounds test only; extended hitTest areas
 * (e.g. quick-access buttons outside the rect) are not consulted.
 */
export function findFloatingRegionAt(
  mouseX: number,
  mouseY: number,
  config: GridConfig,
  viewport: Viewport,
): GridRegion | null {
  const regions = getGridRegions();
  // Reverse so topmost floating overlays are tested first
  for (let i = regions.length - 1; i >= 0; i--) {
    const bounds = getFloatingCanvasBounds(regions[i], config, viewport);
    if (!bounds) continue;
    if (
      mouseX >= bounds.x &&
      mouseX <= bounds.x + bounds.width &&
      mouseY >= bounds.y &&
      mouseY <= bounds.y + bounds.height
    ) {
      return regions[i];
    }
  }
  return null;
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
  ): { region: GridRegion; cursor: string | null } | null => {
    const regions = getGridRegions();
    // Check in reverse so topmost floating overlays are tested first
    for (let i = regions.length - 1; i >= 0; i--) {
      const region = regions[i];
      const bounds = getFloatingCanvasBounds(region, config, viewport);
      if (!bounds) continue;

      const inBounds =
        mouseX >= bounds.x &&
        mouseX <= bounds.x + bounds.width &&
        mouseY >= bounds.y &&
        mouseY <= bounds.y + bounds.height;

      // If within bounds, it's a hit. If outside bounds, consult the
      // registered hitTest callback — overlays can claim extended areas
      // (e.g., quick access buttons rendered outside the chart rect).
      const registration = getOverlayRegistration(region.type);
      const extendedHit = !inBounds && registration?.hitTest
        ? registration.hitTest({
            region,
            canvasX: mouseX,
            canvasY: mouseY,
            row: 0,
            col: 0,
            floatingCanvasBounds: bounds,
          })
        : false;

      if (inBounds || extendedHit) {
        let cursor: string | null = null;
        if (registration?.getCursor) {
          cursor = registration.getCursor({
            region,
            canvasX: mouseX,
            canvasY: mouseY,
            row: 0,
            col: 0,
            floatingCanvasBounds: bounds,
          });
        }
        return { region, cursor };
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
    const hit = checkOverlayBody(mouseX, mouseY);
    if (!hit || !hit.region.floating) return false;

    // A SECONDARY press is a request for a MENU, never a gesture on the object.
    //
    // This line is the whole of the "a right-click must not run the macro" fix,
    // and it is here rather than in Controls' listener because this is the ONLY
    // place in the codebase where a native mousedown becomes
    // `floatingObject:selected` (one dispatch, six listeners). Controls turns
    // that event into `button:clicked` for a run-mode button, so a right-press
    // RAN the user's script; but the same event is also a chart's pending
    // click, a slicer's pending click and a Floating Range's selection, and any
    // listener added later inherits whatever this dispatch means. Filtering in
    // one listener fixes one listener and has to be re-typed by everyone else;
    // filtering here cannot be got round, because an extension cannot reach the
    // dispatch except through this function. It is Core's own path, so it also
    // holds for extensions that do not exist yet.
    //
    // Returning TRUE consumes the press: without that it would fall through to
    // `handleCellMouseDown` and move the cell cursor to the cell UNDER the
    // object, which is what a right-click on a chart must never do. Nothing is
    // lost by not dispatching — every object with a context menu (Charts,
    // Slicer, TimelineSlicer, FloatingRange, and Controls via M3a's
    // `installControlObjectMenu`) SELECTS the clicked object itself from its
    // own capture-phase `contextmenu` listener, because a menu opened with the
    // keyboard Menu key has no mousedown at all.
    if (event.button === 2) return true;

    // checkOverlayBody is pure GEOMETRY — it never looks at what the mouse
    // actually landed on. An extension may stack real DOM over the canvas
    // (the Floating Range cell editor's <textarea> is the live example, and
    // the updateHtmlOverlay contract invites more), and those coordinates sit
    // inside the overlay's own rect. Claiming that mousedown would
    // preventDefault the browser's caret placement and text drag-selection
    // inside the control, and would re-select the object underneath its own
    // editor. Consume the event so no cell-selection handler runs, but leave
    // the default action alone: the control owns its own mousedown.
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return true;
    }

    const region = hit.region;
    event.preventDefault();

    // Notify extensions that a floating overlay was selected (always)
    window.dispatchEvent(new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: region.id,
        regionType: region.type,
        data: region.data,
        ctrlKey: event.ctrlKey,
      },
    }));

    // Generic body-drag claim (e.g. a chart brush): an overlay may take over the
    // in-body drag instead of being moved. Consulted ONLY on a confirmed body hit
    // and ONLY when the registration opts in, so non-opting overlays fall through
    // to the unchanged movable/move path below. The overlay then owns the drag
    // stream via its own window mousemove/up listeners.
    const registration = getOverlayRegistration(region.type);
    if (registration?.claimsBodyDrag) {
      const bounds = getFloatingCanvasBounds(region, config, viewport);
      const claimed = registration.claimsBodyDrag({
        region,
        canvasX: mouseX,
        canvasY: mouseY,
        row: 0,
        col: 0,
        floatingCanvasBounds: bounds ?? undefined,
      });
      if (claimed) {
        window.dispatchEvent(new CustomEvent("floatingObject:bodyDragStart", {
          detail: { regionId: region.id, regionType: region.type, data: region.data, canvasX: mouseX, canvasY: mouseY },
        }));
        return true; // claimed: skip the move; the overlay owns the drag
      }
    }

    // Only start a move drag if the region is movable (extensions set this via data)
    if (region.data?.movable === false) {
      return true; // consumed the click, but no drag
    }

    setIsOverlayMoving(true);
    setCursorStyle("move");

    overlayMoveStateRef.current = {
      region,
      startMouseX: mouseX,
      startMouseY: mouseY,
      startX: region.floating!.x,
      startY: region.floating!.y,
      currentX: region.floating!.x,
      currentY: region.floating!.y,
      hasMoved: false,
    };

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

  /**
   * A DOUBLE-CLICK on a floating overlay, offered to the overlay's owner.
   *
   * WHY THIS EXISTS. Core's `handleDoubleClick` returns null over a floating
   * overlay, and that is correct -- a double-click on a chart must never open
   * the cell editor hidden underneath it. But `checkCellDoubleClickInterceptors`
   * (the @api/cellDoubleClickInterceptors seam) is reached only `if (cell)`, so
   * a null cell meant the existing seam was structurally UNREACHABLE over every
   * floating object: there was no way at all for the extension that owns an
   * overlay to hear about a double-click on it. The Floating Range had to INFER
   * the gesture from two `floatingObject:bodyDragStart` events within 350 ms --
   * a private timer that only worked because the FR happens to opt into
   * `claimsBodyDrag`, and that an overlay which does not claim body drags could
   * not have written at all. The browser already knows what a double-click is.
   *
   * THE CLAIM COMES FIRST, and both halves of it are load-bearing:
   *   - `isPointerClaimed` is Core's one generic rule (core/lib/pointerClaims.ts)
   *     for a gesture that landed inside a surface an extension stacked on the
   *     grid. `gridPointerDoubleClick` already refuses a claimed double-click at
   *     the DOM door, so this is the second wall -- but this function is a NEW
   *     actor on the gesture and an actor that dispatches to extension code
   *     answers the claim itself rather than inheriting someone else's answer.
   *   - the tag check is NOT redundant with it. An on-canvas cell editor --
   *     the Floating Range's own <textarea>, the live example -- carries no
   *     claim attribute, and its coordinates sit squarely inside the overlay's
   *     rect. Without this, double-clicking a word inside the open editor would
   *     be handed to the overlay owner as a fresh double-click on the cell
   *     underneath, tearing down the editor the user is typing in. It is the
   *     same guard `handleOverlayMoveMouseDown` applies to mousedown, for the
   *     same reason: `checkOverlayBody` is pure GEOMETRY and never looks at
   *     what the mouse actually landed on.
   *
   * No `preventDefault()`: like the two guards above, refusing the gesture must
   * leave the browser's own default (the editor's word selection) alone.
   */
  const handleOverlayDoubleClick = (
    region: GridRegion,
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ): boolean => {
    if (isPointerClaimed(event)) return false;

    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return false;
    }

    const registration = getOverlayRegistration(region.type);
    if (!registration?.onDoubleClick) return false;

    const bounds = getFloatingCanvasBounds(region, config, viewport);
    return registration.onDoubleClick({
      region,
      canvasX: mouseX,
      canvasY: mouseY,
      row: 0,
      col: 0,
      floatingCanvasBounds: bounds ?? undefined,
    }) === true;
  };

  return {
    checkOverlayBody,
    handleOverlayMoveMouseDown,
    handleOverlayMoveMouseMove,
    handleOverlayMoveMouseUp,
    handleOverlayDoubleClick,
  };
}
