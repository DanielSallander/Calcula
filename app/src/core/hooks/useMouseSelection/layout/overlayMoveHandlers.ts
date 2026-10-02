//! FILENAME: app/src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts
// PURPOSE: Factory function for creating overlay move handlers for floating overlays.
// CONTEXT: Detects when the mouse is on a floating overlay body and handles
//          drag-to-move. Dispatches generic "floatingObject:moveComplete" and
//          "floatingObject:selected" events so extensions can handle the logic.
//          Also offers a DOUBLE-CLICK on a floating overlay to that overlay's
//          owner via OverlayRegistration.onDoubleClick (@api/gridOverlays) -- the
//          only seam that can reach an extension over a floating object, since
//          the cell double-click interceptors are asked about a CELL.
//
//          ZONES (BUG-0258 phase 2): every floating object gets ONE answer per
//          point -- frame or content -- resolved before the press selects
//          anything, and the press routing, the hover pointer and the meaning
//          of Ctrl/Shift all come from it (`pressZone`, `resolveFloatingZone`
//          in @api/gridOverlays). A family that answers no `zoneAt` is all
//          frame. There is no second route: the per-press body-drag claim and
//          the floating pointer callback it had to be kept in step with by
//          hand were deleted once every family answered `zoneAt` (M5 T6).
//
//          THE GRIP (BUG-0258 design phase 5; core/lib/floatingGrip.ts): a
//          press on an object's visible six-dot grip is a FRAME press on that
//          object (`part: "grip"`) and arms Core's move, whatever the object's
//          zone answer would say -- the grip lies OUTSIDE the object. A drag
//          moves it; a release within the 3px threshold dispatches
//          `floatingObject:gripClick` (the grip's menu). The hook asks for the
//          grip after the resize handles and before any body
//          (`handleGripMouseDown`, priority 1.6).
//
//          THE GESTURE FLAG (core/lib/objectHover.ts): a move that passes its
//          threshold is a Core floating gesture until its release -- no grip
//          shows while one is in progress.

import type { GridConfig, Viewport } from "../../../types";
import {
  getLiveGridRegions,
  getOverlayRegistration,
  floatingHitOrder,
  resolveFloatingZone,
  contentGestureCursorFor,
  clearContentGestureCursor,
  type GridRegion,
  type OverlayHitTestContext,
  type ResolvedFloatingZone,
} from "../../../../api/gridOverlays";
import { noteObjectPress, noteWorksheetObjectPress } from "../../../../api/objectSelection";
import { isPointerClaimed } from "../../../lib/pointerClaims";
import { getLayoutSurface, applySurfaceToMove } from "../../../lib/layoutSurface";
import { getGridStateSnapshot } from "../../../state/GridContext";
import { rowHeaderGutter, colHeaderGutter } from "../../../lib/gridRenderer/layout/headerVisibility";
import {
  FLOATING_GRIP_CLICK_EVENT,
  currentGripZoom,
  floatingGripAnchor,
  floatingGripAt,
  type FloatingGripAnchor,
  type FloatingGripClickDetail,
  type FloatingGripHit,
} from "../../../lib/floatingGrip";
import { setFloatingGestureActive } from "../../../lib/objectHover";

/** The layout surface of the sheet being edited (null = unconstrained). */
function activeLayoutSurface() {
  return getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
}

// ============================================================================
// The release of a move
// ============================================================================

/**
 * The CAPTURE-phase window mouseup Core binds when it arms a move, or null.
 *
 * WHY CAPTURE. A family that binds a bubble-phase window mouseup during the
 * press (the timeline binds one for its pending click from its
 * floatingObject:selected handler; the Slicer's and the chart's live as long
 * as the extension) sits BEFORE Core's own window mouseup, which
 * useMouseSelection re-binds from an effect only once `isOverlayMoving` has
 * committed -- after the press. A release inside the grid area never showed
 * it: React's onMouseUp ends the move before any window bubble listener runs.
 * A release anywhere else (the ribbon, the formula bar, the sheet tabs, a task
 * pane) reached the family FIRST: it took its pending click and dropped its
 * multi-move snapshot, so the moveComplete that followed saved only the lead,
 * and the objects it co-moved snapped back at the next refresh. Window capture
 * runs before React's root dispatch and before every bubble listener,
 * wherever the release lands, so moveComplete now precedes the families'
 * mouseups on EVERY release -- the order an in-grid release always had.
 *
 * LIFETIME (the census row in core/lib/globalInputListeners.ts calls it
 * session-scoped, and that is a claim about its lifetime): bound only by a
 * press that armed a move, removed when that move ends
 * (`handleOverlayMoveMouseUp`, whichever caller ends it -- this listener, the
 * grid area's onMouseUp, the hook's window mouseup), and a stale one -- a
 * release that never came -- is dropped at the next arm. A MODULE slot, because
 * the handlers are re-created on every render; the listener closes over only
 * the stable setters and the move-state ref.
 */
let armedMoveRelease: (() => void) | null = null;

function disarmMoveRelease(): void {
  if (armedMoveRelease === null) return;
  window.removeEventListener("mouseup", armedMoveRelease, true);
  armedMoveRelease = null;
}

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
  /**
   * Set when the press was on the object's GRIP: a release that never moved
   * is a grip CLICK (`floatingObject:gripClick`), anchored at the grip's hit
   * square in CLIENT px.
   */
  grip?: { anchor: FloatingGripAnchor };
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

/**
 * What a point over a floating object is, for Core's press and hover: the
 * object, its ZONE -- resolved here, once, before any press selects anything
 * -- and the pointer, which is the zone's, or the one a live content gesture
 * holds over the object. Never null: a family with no `zoneAt` is all frame,
 * so its pointer is 'move' where it can move and 'default' where it cannot.
 */
export interface OverlayBodyHit {
  region: GridRegion;
  zone: ResolvedFloatingZone;
  cursor: string;
}

export interface OverlayMoveHandlers {
  /** Check if mouse is over a floating overlay body. Returns the region, its zone (zoneAt families) and the cursor. */
  checkOverlayBody: (mouseX: number, mouseY: number) => OverlayBodyHit | null;
  /** The VISIBLE grip under the point (core/lib/floatingGrip.ts), at the painted gutters, or null. */
  checkGrip: (mouseX: number, mouseY: number) => FloatingGripHit | null;
  /**
   * Handle a mousedown on a visible grip: a FRAME press on its object that arms
   * Core's move (a click opens the grip's menu at the release). Returns true
   * when the press was on a grip (consumed), false otherwise.
   */
  handleGripMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ) => boolean;
  /** Handle mousedown on a floating overlay body. Returns true if move started. */
  handleOverlayMoveMouseDown: (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ) => boolean;
  /** Handle mousemove during overlay move drag. */
  /** `altKey` held = move freely, bypassing the snap grid. */
  handleOverlayMoveMouseMove: (mouseX: number, mouseY: number, altKey?: boolean) => void;
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
 *
 * Walks `floatingHitOrder` (@api/gridOverlays): topmost first, the exact
 * reverse of the paint order when a stacking order is in force, reverse
 * publication order otherwise. Over the LIVE regions: nothing of the edit's
 * sheet while cross-sheet point mode shows another one.
 */
export function findFloatingRegionAt(
  mouseX: number,
  mouseY: number,
  config: GridConfig,
  viewport: Viewport,
): GridRegion | null {
  for (const region of floatingHitOrder(getLiveGridRegions())) {
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
    containerRef,
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
  ): OverlayBodyHit | null => {
    // Topmost first (`floatingHitOrder`): the object painted on top is the one
    // a press reaches. LIVE regions only: during cross-sheet point mode the
    // published regions belong to the edit's sheet, not the one on screen.
    for (const region of floatingHitOrder(getLiveGridRegions())) {
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
        // ONE ZONE ANSWER: the press, the pointer and the meaning of
        // Ctrl/Shift all come from this one resolution (BUG-0258). A content
        // gesture that holds the button owns the pointer over its object.
        const ctx: OverlayHitTestContext = {
          region,
          canvasX: mouseX,
          canvasY: mouseY,
          row: 0,
          col: 0,
          floatingCanvasBounds: bounds,
        };
        const zone = resolveFloatingZone(ctx);
        return { region, zone, cursor: contentGestureCursorFor(region.id) ?? zone.cursor };
      }
    }
    return null;
  };

  /**
   * Arm Core's MOVE of `region` from this press: a frame press on an object
   * that may move. The move itself starts past the 3px threshold. A press on
   * the object's GRIP passes the grip's client-px anchor, which makes a
   * release that never moved a grip CLICK.
   */
  const armMove = (
    region: GridRegion,
    mouseX: number,
    mouseY: number,
    opts: { gripAnchor?: FloatingGripAnchor } = {},
  ): void => {
    setIsOverlayMoving(true);
    setCursorStyle("move");
    // A gesture flag left over from a move whose release never came.
    setFloatingGestureActive(false);

    overlayMoveStateRef.current = {
      region,
      startMouseX: mouseX,
      startMouseY: mouseY,
      startX: region.floating!.x,
      startY: region.floating!.y,
      currentX: region.floating!.x,
      currentY: region.floating!.y,
      hasMoved: false,
      ...(opts.gripAnchor ? { grip: { anchor: opts.gripAnchor } } : {}),
    };

    // End this move at ITS release, before any family hears the release (see
    // `armedMoveRelease`). One still bound here belongs to a release that
    // never came.
    disarmMoveRelease();
    const endMoveOnRelease = (): void => handleOverlayMoveMouseUp();
    armedMoveRelease = endMoveOnRelease;
    window.addEventListener("mouseup", endMoveOnRelease, true);
  };

  /**
   * A press on a floating object, in the zone grammar's order. `zone` was
   * resolved BEFORE this runs (checkOverlayBody), so nothing the press
   * selects can change what the press is -- a family whose zone depended on
   * its own selection would otherwise answer the POST-press question.
   *
   * PRESS PARITY ON A CANVAS. Every family reads the `selected` dispatch in
   * its own way, and only the pivot box ever deselected on ANOTHER family's
   * press, so a chart and a slicer could both be selected by two plain
   * clicks. The object-selection seam decides what the press means for the
   * canvas-wide selection set BEFORE the families hear it: a plain press
   * selects one object (other families deselected), Ctrl/Shift on the FRAME
   * adds or removes, and a plain press on a member of a multi-selection keeps
   * the set for a group drag, narrowing at mouseup. It never dispatches
   * anything itself -- the press below stays the families' one click signal.
   *
   * PRESS PARITY ON A WORKSHEET (BUG-0270 review): the plain rule only,
   * through `noteWorksheetObjectPress` -- a plain press deselects every OTHER
   * family, a Ctrl/Shift press keeps them, nothing is armed (a worksheet has
   * no cross-family group drag). Without it a chart clicked before a slicer
   * stayed selected beside it, and Delete removed the chart clicked EARLIER.
   *
   *   1. the seam's press hook -- noteObjectPress on a canvas,
   *      noteWorksheetObjectPress on a worksheet. Ctrl/Shift reach object
   *      selection only from the FRAME. On content they are the content's
   *      (Shift+click extends a timeline's range; it must not toggle the
   *      timeline out of a canvas selection), so the press is a plain one there.
   *   2. floatingObject:selected, carrying the zone, its part, the point and
   *      the OBJECT-selection modifiers -- false on content.
   *   3. content: floatingObject:bodyDragStart with the part and the RAW
   *      modifiers, and never a move -- also on a locked object, an immovable
   *      one and a subscribed page (reading the report is not editing it).
   *   4. frame: Core's move, only when the object can move. Otherwise the
   *      press only selects: no move is armed, no 'move' pointer is set.
   */
  const pressZone = (
    region: GridRegion,
    zone: ResolvedFloatingZone,
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ): boolean => {
    const content = zone.kind === "content";

    const pressMods = content ? {} : { ctrlKey: event.ctrlKey, shiftKey: event.shiftKey };
    if (getGridStateSnapshot()?.surface === "canvas") {
      noteObjectPress(region, pressMods);
    } else {
      noteWorksheetObjectPress(region, pressMods);
    }

    window.dispatchEvent(new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: region.id,
        regionType: region.type,
        data: region.data,
        zone: zone.kind,
        part: zone.part,
        canvasX: mouseX,
        canvasY: mouseY,
        ctrlKey: content ? false : event.ctrlKey,
        shiftKey: content ? false : event.shiftKey,
      },
    }));

    if (content) {
      window.dispatchEvent(new CustomEvent("floatingObject:bodyDragStart", {
        detail: {
          regionId: region.id,
          regionType: region.type,
          data: region.data,
          canvasX: mouseX,
          canvasY: mouseY,
          part: zone.part,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
        },
      }));
      return true; // the content owns the press; Core never moves the object
    }

    if (!zone.canMove) return true; // selected; nothing moves it

    armMove(region, mouseX, mouseY);
    return true;
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
    // This line is the first wall of the "a right-click must not run the macro"
    // fix, and it is here rather than in a family's listener because this is
    // where a native mousedown on an object's body becomes
    // `floatingObject:selected` -- and, on CONTENT, `floatingObject:bodyDragStart`
    // (one dispatch each, many listeners; the grip's press below is the only
    // other door, with its own button-2 return). A run-mode button RUNS from the
    // second: Controls starts its press at bodyDragStart and runs it at a
    // PRIMARY release inside it (Controls/lib/buttonPress.ts, BUG-0258 phase
    // 4c). Before that it ran from `selected`, so a right-press RAN the user's
    // script. Returning here dispatches neither, so a secondary press never
    // reaches either listener, whichever event a family acts on. The same
    // events are also a chart's pending click and its buttons, a slicer's items,
    // a pivot box's chrome and a Floating Range's selection, and any listener
    // added later inherits whatever these dispatches mean. Filtering in one
    // listener fixes one listener and has to be re-typed by everyone else;
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

    // No content gesture's pointer outlives the next object press: a hold
    // whose release never came is dropped here (the backstop).
    clearContentGestureCursor();

    // ONE ZONE ANSWER (`OverlayRegistration.zoneAt`, or all frame without
    // one), resolved by checkOverlayBody above, before anything here selects.
    return pressZone(region, hit.zone, mouseX, mouseY, event);
  };

  /**
   * The VISIBLE grip under the point, at the PAINTED gutters (a canvas and a
   * headings-off sheet have none), the viewport's scroll and the zoom the
   * painter reads -- or null. LIVE regions only, like the body.
   */
  const checkGrip = (mouseX: number, mouseY: number): FloatingGripHit | null =>
    floatingGripAt(
      mouseX,
      mouseY,
      { rowHeaderWidth: rowHeaderGutter(config), colHeaderHeight: colHeaderGutter(config) },
      { scrollX: viewport.scrollX || 0, scrollY: viewport.scrollY || 0 },
      currentGripZoom(),
      getLiveGridRegions(),
    );

  /**
   * A press on an object's visible GRIP: a FRAME press on that object, in the
   * zone grammar's order (see `pressZone`), that always arms Core's move --
   * the grip shows only on an object that can move. `part: "grip"` tells every
   * family's `floatingObject:selected` listener that the press must never act
   * (no pending click, no filter, no run); a release that never moved is a
   * grip CLICK (`handleOverlayMoveMouseUp`).
   *
   *   - a SECONDARY press is consumed and does nothing: the contextmenu that
   *     follows decides (a family's own menu where it claims the point, else
   *     Core's grid contextmenu dispatches the grip click with button 2);
   *   - a press on an editable DOM control stacked on the canvas is left alone
   *     (the rule `handleOverlayMoveMouseDown` applies);
   *   - the seam's press hook with the RAW modifiers -- `noteObjectPress` on a
   *     canvas, `noteWorksheetObjectPress` on a worksheet: the grip is frame,
   *     so Ctrl/Shift mean object selection there.
   */
  const handleGripMouseDown = (
    mouseX: number,
    mouseY: number,
    event: React.MouseEvent<HTMLElement>,
  ): boolean => {
    const hit = checkGrip(mouseX, mouseY);
    if (!hit || !hit.region.floating) return false;

    if (event.button === 2) return true;

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
    clearContentGestureCursor();

    if (getGridStateSnapshot()?.surface === "canvas") {
      noteObjectPress(region, { ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
    } else {
      noteWorksheetObjectPress(region, { ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
    }

    window.dispatchEvent(new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: region.id,
        regionType: region.type,
        data: region.data,
        zone: "frame",
        part: "grip",
        canvasX: mouseX,
        canvasY: mouseY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      },
    }));

    const container = containerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    armMove(region, mouseX, mouseY, { gripAnchor: floatingGripAnchor(hit.grip, container, currentGripZoom()) });
    return true;
  };

  /**
   * Handle mousemove during overlay move drag.
   * Updates position and dispatches a live preview event.
   */
  const handleOverlayMoveMouseMove = (
    mouseX: number,
    mouseY: number,
    altKey: boolean = false,
  ): void => {
    const moveState = overlayMoveStateRef.current;
    if (!moveState) return;

    // CONSUME MODE (a subscribed canvas; Design Mode is never part of it, see
    // LayoutSurface.editable): the object was selected by the press, but no
    // drag may change its geometry. Returning before `hasMoved` is set means
    // mouse-up dispatches no moveComplete.
    const surface = activeLayoutSurface();
    if (surface && !surface.editable) return;

    const deltaX = mouseX - moveState.startMouseX;
    const deltaY = mouseY - moveState.startMouseY;

    // Mark as moved if we've gone beyond a small threshold. From here to the
    // release this is a Core floating GESTURE: no grip shows while it lasts.
    if (!moveState.hasMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      moveState.hasMoved = true;
      setFloatingGestureActive(true);
    }

    // On a laid-out surface, pointer jitter inside the click threshold moves
    // NOTHING: snapping a 1px wobble would jump an off-grid object to the grid
    // on a plain click (and a family that persists previews would save it).
    // Worksheets keep their previous behaviour.
    if (surface && !moveState.hasMoved) return;

    // Clamp to non-negative sheet coordinates
    let newX = Math.max(0, moveState.startX + deltaX);
    let newY = Math.max(0, moveState.startY + deltaY);

    // SNAP + PAGE (the layout surface). Applied HERE, the one point every
    // family's move geometry passes through: mouse-up re-dispatches exactly
    // these values as moveComplete, so the preview and the persisted position
    // can never disagree. Alt moves freely; a family with its own quantisation
    // opts out with `region.data.snap === false`.
    if (surface) {
      const floating = moveState.region.floating;
      const snapped = applySurfaceToMove(
        surface,
        { x: newX, y: newY, width: floating?.width ?? 0, height: floating?.height ?? 0 },
        { bypassSnap: altKey, optOutSnap: moveState.region.data?.snap === false },
      );
      newX = snapped.x;
      newY = snapped.y;
    }

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
    // The capture listener's own unbind, for every caller: after the first
    // one ends the move, the grid area's onMouseUp and the hook's window
    // mouseup find no move state and end nothing.
    disarmMoveRelease();
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
    setFloatingGestureActive(false);

    // A press on the GRIP that never moved is a grip CLICK: the grip's menu
    // (Size and Position first) opens at the grip. Dispatched after Core's
    // own move state is cleared, so a listener finds no move in progress.
    if (moveState.grip && !moveState.hasMoved) {
      const detail: FloatingGripClickDetail = {
        regionId: moveState.region.id,
        regionType: moveState.region.type,
        data: moveState.region.data,
        anchor: moveState.grip.anchor,
        button: 0,
      };
      window.dispatchEvent(new CustomEvent(FLOATING_GRIP_CLICK_EVENT, { detail }));
    }
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
   * a private timer that only worked because the FR happened to take its body
   * presses for itself, and that an overlay which does not take them could
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
    checkGrip,
    handleGripMouseDown,
    handleOverlayMoveMouseDown,
    handleOverlayMoveMouseMove,
    handleOverlayMoveMouseUp,
    handleOverlayDoubleClick,
  };
}
